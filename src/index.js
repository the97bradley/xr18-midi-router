const midi = require("midi");
const osc = require("osc");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2), {
  string: ["xr18-ip", "midi-in", "midi-out"],
  boolean: ["debug"],
  default: {
    "xr18-ip": process.env.XR18_IP || "192.168.1.100",
    "xr18-port": Number(process.env.XR18_PORT || 10024),
    "listen-port": Number(process.env.LISTEN_PORT || 10025),
    send: Number(process.env.XR18_SEND || 0), // 0=LR, 1..6=bus send masters
    debug: false,
  },
});

const DEBUG = argv.debug;
const log = (...args) => console.log("[xr18-midi-router]", ...args);
const dbg = (...args) => DEBUG && console.log("[debug]", ...args);

const oscPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: argv["listen-port"],
  remoteAddress: argv["xr18-ip"],
  remotePort: argv["xr18-port"],
  metadata: true,
});

const midiIn = new midi.Input();
const midiOut = new midi.Output();

let bankOffset = 0; // 0 => channels 1-8
const MAX_CHANNELS = 18;
const lastMcuWriteAt = new Map(); // channelNumber -> timestamp(ms)
const lastMotorRaw = new Map(); // channelNumber -> 14-bit value sent to motor
const channelOnState = new Map(); // channelNumber -> 0|1  (XR18 /mix/on)
const channelSoloState = new Map(); // channelNumber -> 0|1 (router-local mirror)
const channelNames = new Map(); // channelNumber -> string
let masterRaw = 0;
let currentSend = Math.max(0, Math.min(6, Number(argv.send) || 0)); // 0=LR, 1..6 sends

function listPorts() {
  const ins = [];
  const outs = [];

  const tempIn = new midi.Input();
  const tempOut = new midi.Output();

  for (let i = 0; i < tempIn.getPortCount(); i++) ins.push(tempIn.getPortName(i));
  for (let i = 0; i < tempOut.getPortCount(); i++) outs.push(tempOut.getPortName(i));

  tempIn.closePort?.();
  tempOut.closePort?.();

  return { ins, outs };
}

function findPortIndex(device, preferredName) {
  for (let i = 0; i < device.getPortCount(); i++) {
    const name = device.getPortName(i);
    if (preferredName ? name.includes(preferredName) : name.toLowerCase().includes("mackie")) {
      return i;
    }
  }
  return -1;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Basic channel map: MCU faders 1-8 -> XR18 channels 1-8
// Pitch bend status: 0xE0..0xE7 (ch 1..8)
function channelAddress(channelNumber) {
  const ch = String(channelNumber).padStart(2, "0");
  if (currentSend >= 1 && currentSend <= 6) {
    const bus = String(currentSend).padStart(2, "0");
    return `/ch/${ch}/mix/${bus}/level`;
  }
  return `/ch/${ch}/mix/fader`;
}

function channelNameAddress(channelNumber) {
  const ch = String(channelNumber).padStart(2, "0");
  return `/ch/${ch}/config/name`;
}

function masterAddress() {
  if (currentSend >= 1 && currentSend <= 6) {
    const bus = String(currentSend).padStart(2, "0");
    return `/bus/${bus}/mix/fader`;
  }
  return `/lr/mix/fader`;
}

function targetLabel() {
  return currentSend >= 1 && currentSend <= 6 ? `S${currentSend}` : "LR";
}

function normalizeChannelName(name) {
  const s = (name || "").toString().trim();
  // Strip leading channel index patterns like:
  // "1 - Vocal", "01- Kick", "2: Bass", "3.Tom"
  return s.replace(/^\s*\d{1,2}\s*[-:.]\s*/u, "").trim() || s;
}

function toLcdText(s, len = 7) {
  const clean = (s || "").toString().replace(/[^\x20-\x7E]/g, " ").slice(0, len);
  const totalPad = Math.max(0, len - clean.length);
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return `${" ".repeat(left)}${clean}${" ".repeat(right)}`;
}

function writeMcuScribble(strip, topText = "", bottomText = "") {
  // Mackie LCD SysEx: F0 00 00 66 14 12 <offset> <ascii...> F7
  // 2 rows x 56 chars. Each strip width = 7 chars.
  const topOffset = (strip - 1) * 7;
  const bottomOffset = 56 + (strip - 1) * 7;

  const sendText = (offset, text) => {
    const bytes = Array.from(Buffer.from(toLcdText(text, 7), "ascii"));
    midiOut.sendMessage([0xf0, 0x00, 0x00, 0x66, 0x14, 0x12, offset, ...bytes, 0xf7]);
  };

  sendText(topOffset, topText);
  sendText(bottomOffset, bottomText);
}

function splitNameForScribble(channelNumber, name) {
  const cleaned = normalizeChannelName(name);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const prefix = String(channelNumber);
  const maxTop = 7;
  const room = Math.max(0, maxTop - (prefix.length + 1));

  if (!cleaned) return [prefix, ""];

  // Strategy:
  // - If we can fit number + at least a chunk of first word, do it.
  // - Multi-word names: top gets number + first word chunk, bottom gets remaining words.
  // - Single-word names: split the word across top/bottom to use full space.
  if (room <= 0) return [prefix.slice(0, maxTop), cleaned];

  if (words.length > 1) {
    const first = words[0];
    const topWord = first.slice(0, room);
    const top = `${prefix} ${topWord}`;

    let bottom = words.slice(1).join(" ");
    if (first.length > topWord.length) {
      const remainder = first.slice(topWord.length);
      bottom = `${remainder} ${bottom}`.trim();
    }
    return [top, bottom];
  }

  // Single-word: number on top, full word on bottom.
  const word = words[0];
  return [prefix, word];
}

function sendMcuMotor(strip, raw14) {
  // Mackie motor faders use pitch bend per strip channel.
  const status = 0xe0 + (strip - 1); // strip 1 => 0xE0
  const lsb = raw14 & 0x7f;
  const msb = (raw14 >> 7) & 0x7f;
  midiOut.sendMessage([status, lsb, msb]);
}

function setButtonLed(note, on) {
  // MCU LEDs are driven with NOTE ON velocity 0/127 on ch1.
  midiOut.sendMessage([0x90, note & 0x7f, on ? 0x7f : 0x00]);
}

function updateStripLeds(strip, channelNumber) {
  const muteNote = 0x10 + (strip - 1);
  const soloNote = 0x08 + (strip - 1);

  if (channelNumber < 1 || channelNumber > MAX_CHANNELS) {
    setButtonLed(muteNote, false);
    setButtonLed(soloNote, false);
    return;
  }

  const onState = channelOnState.get(channelNumber);
  if (typeof onState === "number") {
    const muted = onState === 0;
    setButtonLed(muteNote, muted);
  } else {
    setButtonLed(muteNote, false);
  }

  const soloState = channelSoloState.get(channelNumber);
  if (typeof soloState === "number") {
    setButtonLed(soloNote, !!soloState);
  } else {
    setButtonLed(soloNote, false);
  }
}

function stripBottomLabel(strip, defaultBottom) {
  return strip === 8 ? targetLabel() : defaultBottom;
}

function refreshSurface() {
  for (let strip = 1; strip <= 8; strip++) {
    const channelNumber = strip + bankOffset;
    if (channelNumber >= 1 && channelNumber <= MAX_CHANNELS) {
      const rawName = channelNames.get(channelNumber) || `CH ${channelNumber}`;
      const [top, bottom] = splitNameForScribble(channelNumber, rawName);
      writeMcuScribble(strip, top, stripBottomLabel(strip, bottom));
    } else {
      writeMcuScribble(strip, "", stripBottomLabel(strip, ""));
      sendMcuMotor(strip, 0);
    }
    updateStripLeds(strip, channelNumber);
  }
}

function setSendMode(next) {
  const clamped = Math.max(0, Math.min(6, next));
  if (clamped === currentSend) return;
  currentSend = clamped;
  log(`Send mode: ${targetLabel()}`);
  refreshSurface();
}

function shiftBank(delta) {
  const old = bankOffset;
  bankOffset = Math.max(0, Math.min(MAX_CHANNELS - 1, bankOffset + delta));
  if (old !== bankOffset) {
    log(`Bank shifted: channels ${bankOffset + 1}-${bankOffset + 8}`);
    refreshSurface();
  }
}

function handleMcuMessage(delta, message) {
  const [status, data1, data2] = message;

  // Pitch bend (14-bit) for faders.
  if ((status & 0xf0) === 0xe0) {
    const strip = (status & 0x0f) + 1; // 1..8 strips, 9=master
    const raw14 = (data2 << 7) | data1; // 0..16383
    const linear = clamp(raw14 / 16383, 0, 1);

    if (strip === 9) {
      const addr = masterAddress();
      lastMcuWriteAt.set(1000, Date.now()); // sentinel for master touch guard
      dbg("master", { strip, raw14, linear, addr, target: targetLabel() });
      oscPort.send({
        address: addr,
        args: [{ type: "f", value: linear }],
      });
      return;
    }

    const channelNumber = strip + bankOffset;
    if (channelNumber < 1 || channelNumber > MAX_CHANNELS) return;
    const addr = channelAddress(channelNumber);

    lastMcuWriteAt.set(channelNumber, Date.now());

    dbg("fader", { strip, channelNumber, raw14, linear, addr });

    oscPort.send({
      address: addr,
      args: [{ type: "f", value: linear }],
    });

    return;
  }

  // Note buttons: treat as toggle on NOTE-ON only (ignore NOTE-OFF)
  // MCU convention (typical):
  // - Solo row: 0x08..0x0F
  // - Mute row: 0x10..0x17
  const command = status & 0xf0;
  if (command === 0x90 || command === 0x80) {
    const note = data1;
    const velocity = data2;
    const noteOn = command === 0x90 && velocity > 0;

    if (!noteOn) return;

    // Send mode toggle via buttons next to ZOOM (observed: 0x6F left, 0x70 right)
    if (note === 0x6f) {
      setSendMode(currentSend - 1);
      return;
    }
    if (note === 0x70) {
      setSendMode(currentSend + 1);
      return;
    }

    // Navigation: channel/bank left-right
    // This MCU reports CH< > as 0x30/0x31 and BANK< > as 0x2E/0x2F.
    if (note === 0x30) {
      shiftBank(-1);
      return;
    }
    if (note === 0x31) {
      shiftBank(1);
      return;
    }
    if (note === 0x2e) {
      shiftBank(-8);
      return;
    }
    if (note === 0x2f) {
      shiftBank(8);
      return;
    }

    // Mute toggle
    if (note >= 0x10 && note <= 0x17) {
      const strip = note - 0x10 + 1;
      const channelNumber = strip + bankOffset;
      if (channelNumber < 1 || channelNumber > MAX_CHANNELS) return;
      const ch = String(channelNumber).padStart(2, "0");
      const addr = `/ch/${ch}/mix/on`;

      const currentOn = channelOnState.has(channelNumber)
        ? channelOnState.get(channelNumber)
        : 1;
      const nextOn = currentOn ? 0 : 1;
      channelOnState.set(channelNumber, nextOn);
      updateStripLeds(strip, channelNumber);

      dbg("mute-toggle", { strip, note, addr, currentOn, nextOn });

      oscPort.send({
        address: addr,
        args: [{ type: "i", value: nextOn }],
      });
      return;
    }

    // Solo toggle (best-effort XR18 path)
    if (note >= 0x08 && note <= 0x0f) {
      const strip = note - 0x08 + 1;
      const channelNumber = strip + bankOffset;
      if (channelNumber < 1 || channelNumber > MAX_CHANNELS) return;
      const ch = String(channelNumber).padStart(2, "0");
      const addr = `/ch/${ch}/mix/solo`;
      const altAddr = `/-stat/solosw/${ch}`;

      const currentSolo = channelSoloState.has(channelNumber)
        ? channelSoloState.get(channelNumber)
        : 0;
      const nextSolo = currentSolo ? 0 : 1;
      channelSoloState.set(channelNumber, nextSolo);
      updateStripLeds(strip, channelNumber);

      dbg("solo-toggle", { strip, note, addr, altAddr, currentSolo, nextSolo });

      // Try both known solo paths (firmware differences).
      oscPort.send({
        address: addr,
        args: [{ type: "i", value: nextSolo }],
      });
      oscPort.send({
        address: altAddr,
        args: [{ type: "i", value: nextSolo }],
      });
      return;
    }

    dbg("note-unmapped", { status, note, velocity });
  }
}

function start() {
  const { ins, outs } = listPorts();
  log("MIDI inputs:", ins.length ? ins.join(" | ") : "none");
  log("MIDI outputs:", outs.length ? outs.join(" | ") : "none");

  const inIndex = findPortIndex(midiIn, argv["midi-in"]);
  const outIndex = findPortIndex(midiOut, argv["midi-out"]);

  if (inIndex < 0) {
    throw new Error("No matching MIDI input port found (set --midi-in).");
  }
  if (outIndex < 0) {
    throw new Error("No matching MIDI output port found (set --midi-out).");
  }

  midiIn.openPort(inIndex);
  midiOut.openPort(outIndex);
  midiIn.ignoreTypes(false, false, false);

  log(`Connected MIDI IN: ${midiIn.getPortName(inIndex)}`);
  log(`Connected MIDI OUT: ${midiOut.getPortName(outIndex)}`);
  log(`XR18 target: ${argv["xr18-ip"]}:${argv["xr18-port"]}`);

  oscPort.on("ready", () => {
    log(`OSC ready (local ${argv["listen-port"]})`);

    // Keep XR remote session alive.
    oscPort.send({ address: "/xremote", args: [] });
    setInterval(() => {
      oscPort.send({ address: "/xremote", args: [] });
    }, 9000);

    // Poll active bank fader states so MCU motor faders stay synchronized.
    setInterval(() => {
      for (let strip = 1; strip <= 8; strip++) {
        const channelNumber = strip + bankOffset;
        if (channelNumber < 1 || channelNumber > MAX_CHANNELS) continue;
        const ch = String(channelNumber).padStart(2, "0");
        oscPort.send({ address: channelAddress(channelNumber), args: [] });
        oscPort.send({ address: `/ch/${ch}/mix/on`, args: [] });
        oscPort.send({ address: `/ch/${ch}/mix/solo`, args: [] });
        oscPort.send({ address: `/-stat/solosw/${ch}`, args: [] });
      }
      oscPort.send({ address: masterAddress(), args: [] });
    }, 300);

    // Poll names at slower cadence and update scribble strips.
    setInterval(() => {
      for (let strip = 1; strip <= 8; strip++) {
        const channelNumber = strip + bankOffset;
        if (channelNumber < 1 || channelNumber > MAX_CHANNELS) continue;
        oscPort.send({ address: channelNameAddress(channelNumber), args: [] });
      }
    }, 2000);

    // Initial labels until names arrive.
    refreshSurface();
  });

  oscPort.on("message", (msg) => {
    dbg("osc<-", msg.address, msg.args?.map((a) => a.value));

    const faderMatch = msg.address?.match(/^\/ch\/(\d{2})\/mix\/fader$/);
    if (faderMatch && msg.args?.length) {
      const channelNumber = Number(faderMatch[1]);
      const strip = channelNumber - bankOffset;
      if (strip < 1 || strip > 8) return;

      const arg = msg.args[0];
      const value = Number(arg?.value);
      if (!Number.isFinite(value)) return;

      const raw14 = clamp(Math.round(value * 16383), 0, 16383);

      // Avoid immediate motor-echo fights while user is actively moving that strip.
      const lastWrite = lastMcuWriteAt.get(channelNumber) || 0;
      if (Date.now() - lastWrite < 120) return;

      const prev = lastMotorRaw.get(channelNumber);
      if (prev === raw14) return;

      sendMcuMotor(strip, raw14);
      lastMotorRaw.set(channelNumber, raw14);
      return;
    }

    if (msg.address === masterAddress() && msg.args?.length) {
      const value = Number(msg.args[0]?.value);
      if (!Number.isFinite(value)) return;
      const raw14 = clamp(Math.round(value * 16383), 0, 16383);

      const lastWrite = lastMcuWriteAt.get(1000) || 0;
      if (Date.now() - lastWrite < 120) return;
      if (masterRaw !== raw14) {
        sendMcuMotor(9, raw14);
        masterRaw = raw14;
      }
      return;
    }

    const nameMatch = msg.address?.match(/^\/ch\/(\d{2})\/config\/name$/);
    if (nameMatch && msg.args?.length) {
      const channelNumber = Number(nameMatch[1]);
      const strip = channelNumber - bankOffset;
      const value = msg.args[0]?.value;
      if (typeof value === "string") {
        const cleaned = normalizeChannelName(value);
        channelNames.set(channelNumber, cleaned);
        if (strip >= 1 && strip <= 8) {
          const [top, bottom] = splitNameForScribble(channelNumber, cleaned);
          writeMcuScribble(strip, top, stripBottomLabel(strip, bottom));
        }
      }
      return;
    }

    const onMatch = msg.address?.match(/^\/ch\/(\d{2})\/mix\/on$/);
    if (onMatch && msg.args?.length) {
      const channelNumber = Number(onMatch[1]);
      const value = Number(msg.args[0]?.value);
      if (Number.isFinite(value)) {
        channelOnState.set(channelNumber, value ? 1 : 0);
        const strip = channelNumber - bankOffset;
        if (strip >= 1 && strip <= 8) updateStripLeds(strip, channelNumber);
      }
      return;
    }

    const soloMatch = msg.address?.match(/^\/ch\/(\d{2})\/mix\/solo$/);
    if (soloMatch && msg.args?.length) {
      const channelNumber = Number(soloMatch[1]);
      const value = Number(msg.args[0]?.value);
      if (Number.isFinite(value)) {
        channelSoloState.set(channelNumber, value ? 1 : 0);
        const strip = channelNumber - bankOffset;
        if (strip >= 1 && strip <= 8) updateStripLeds(strip, channelNumber);
      }
      return;
    }

    const soloAltMatch = msg.address?.match(/^\/-stat\/solosw\/(\d{2})$/);
    if (soloAltMatch && msg.args?.length) {
      const channelNumber = Number(soloAltMatch[1]);
      const value = Number(msg.args[0]?.value);
      if (Number.isFinite(value)) {
        channelSoloState.set(channelNumber, value ? 1 : 0);
        const strip = channelNumber - bankOffset;
        if (strip >= 1 && strip <= 8) updateStripLeds(strip, channelNumber);
      }
      return;
    }
  });

  midiIn.on("message", handleMcuMessage);
  oscPort.open();
}

start();

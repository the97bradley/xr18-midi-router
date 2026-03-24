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

const BANK_OFFSET = 0; // TODO: add banking (0 => channels 1-8)
const lastMcuWriteAt = new Map(); // channelNumber -> timestamp(ms)
const lastMotorRaw = new Map(); // channelNumber -> 14-bit value sent to motor
const channelOnState = new Map(); // channelNumber -> 0|1  (XR18 /mix/on)
const channelSoloState = new Map(); // channelNumber -> 0|1 (router-local mirror)

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
  return `/ch/${ch}/mix/fader`;
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

  const onState = channelOnState.get(channelNumber);
  if (typeof onState === "number") {
    const muted = onState === 0;
    setButtonLed(muteNote, muted);
  }

  const soloState = channelSoloState.get(channelNumber);
  if (typeof soloState === "number") {
    setButtonLed(soloNote, !!soloState);
  }
}

function handleMcuMessage(delta, message) {
  const [status, data1, data2] = message;

  // Pitch bend (14-bit) for faders.
  if ((status & 0xf0) === 0xe0) {
    const strip = (status & 0x0f) + 1; // 1..8
    const channelNumber = strip + BANK_OFFSET;
    const raw14 = (data2 << 7) | data1; // 0..16383
    const linear = clamp(raw14 / 16383, 0, 1);
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

    // Mute toggle
    if (note >= 0x10 && note <= 0x17) {
      const strip = note - 0x10 + 1;
      const channelNumber = strip + BANK_OFFSET;
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
      const channelNumber = strip + BANK_OFFSET;
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
        const channelNumber = strip + BANK_OFFSET;
        const ch = String(channelNumber).padStart(2, "0");
        oscPort.send({ address: channelAddress(channelNumber), args: [] });
        oscPort.send({ address: `/ch/${ch}/mix/on`, args: [] });
        oscPort.send({ address: `/ch/${ch}/mix/solo`, args: [] });
        oscPort.send({ address: `/-stat/solosw/${ch}`, args: [] });
      }
    }, 300);
  });

  oscPort.on("message", (msg) => {
    dbg("osc<-", msg.address, msg.args?.map((a) => a.value));

    const faderMatch = msg.address?.match(/^\/ch\/(\d{2})\/mix\/fader$/);
    if (faderMatch && msg.args?.length) {
      const channelNumber = Number(faderMatch[1]);
      const strip = channelNumber - BANK_OFFSET;
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

    const onMatch = msg.address?.match(/^\/ch\/(\d{2})\/mix\/on$/);
    if (onMatch && msg.args?.length) {
      const channelNumber = Number(onMatch[1]);
      const value = Number(msg.args[0]?.value);
      if (Number.isFinite(value)) {
        channelOnState.set(channelNumber, value ? 1 : 0);
        const strip = channelNumber - BANK_OFFSET;
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
        const strip = channelNumber - BANK_OFFSET;
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
        const strip = channelNumber - BANK_OFFSET;
        if (strip >= 1 && strip <= 8) updateStripLeds(strip, channelNumber);
      }
      return;
    }
  });

  midiIn.on("message", handleMcuMessage);
  oscPort.open();
}

start();

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
function handleMcuMessage(delta, message) {
  const [status, data1, data2] = message;

  // Pitch bend (14-bit) for faders.
  if ((status & 0xf0) === 0xe0) {
    const strip = (status & 0x0f) + 1; // 1..8
    const raw14 = (data2 << 7) | data1; // 0..16383
    const linear = clamp(raw14 / 16383, 0, 1);
    const addr = `/ch/0${strip}/mix/fader`.replace("/ch/010", "/ch/10").replace("/ch/011", "/ch/11").replace("/ch/012", "/ch/12");

    dbg("fader", { strip, raw14, linear, addr });

    oscPort.send({
      address: addr,
      args: [{ type: "f", value: linear }],
    });

    return;
  }

  // Note on/off for mute buttons (starter mapping)
  // Common MCU mute note numbers: 0x10..0x17 (16..23) on channel 1
  const command = status & 0xf0;
  if (command === 0x90 || command === 0x80) {
    const note = data1;
    const velocity = data2;
    const isOn = command === 0x90 && velocity > 0;

    if (note >= 0x10 && note <= 0x17) {
      const strip = note - 0x10 + 1;
      const addr = `/ch/0${strip}/mix/on`.replace("/ch/010", "/ch/10").replace("/ch/011", "/ch/11").replace("/ch/012", "/ch/12");
      const onValue = isOn ? 0 : 1; // mute button ON => channel OFF

      dbg("mute", { strip, note, isOn, addr, onValue });

      oscPort.send({
        address: addr,
        args: [{ type: "i", value: onValue }],
      });
    }
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

    // Subscribe for meter/state updates later.
    oscPort.send({ address: "/xremote", args: [] });
    setInterval(() => {
      oscPort.send({ address: "/xremote", args: [] });
    }, 9000);
  });

  oscPort.on("message", (msg) => {
    dbg("osc<-", msg.address, msg.args?.map((a) => a.value));
    // TODO: map XR18 state back to MCU motor faders and LEDs.
  });

  midiIn.on("message", handleMcuMessage);
  oscPort.open();
}

start();

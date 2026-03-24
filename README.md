# xr18-midi-router

MCU (Mackie Control Unit) ↔ XR18 bridge.

This is a lightweight daemon that translates MCU MIDI controls to XR18 OSC.

## What works (v0.2)

- Detect/connect MIDI in/out ports (MCU)
- Fader mapping: MCU strips 1-8 → XR18 channels 1-8 (`/ch/01..08/mix/fader`)
- Basic mute mapping: MCU mute notes 0x10..0x17 → `/ch/01..08/mix/on`
- Polls XR18 fader values and drives MCU motorized faders to stay synced
- Keeps XR18 remote session alive via `/xremote`

## Next

- Bank switching (1-8 / 9-16 / aux)
- Bidirectional feedback (motorized faders + LEDs)
- Mode toggle (Logic mode vs XR18 mode)
- Config file for custom maps

## Usage

```bash
npm install
node src/index.js --xr18-ip 192.168.50.50 --midi-in "Mackie" --midi-out "Mackie" --debug
```

If `--midi-in`/`--midi-out` are omitted, it tries to auto-match ports containing `mackie`.

## Notes

- XR18 OSC default port: `10024`
- This project targets simple live routing first, polish later.

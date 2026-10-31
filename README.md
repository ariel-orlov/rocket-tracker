# Rocket Tracker

A GPS tracker for rocket launches, and the web app that shows it live.

**App:** https://ariel-orlov.github.io/rocket-tracker/ (Chrome or Edge on a computer; Chrome on Android over Bluetooth)

- **Live**: the rocket on a satellite map with its flight path, pad distance rings, apogee and a predicted landing
  circle while it comes down. The side panel reorders itself for the phase: pre-flight check on the pad, altitude and
  vertical speed in the air, the walk to the rocket after landing.
- **Launch type**: **Competition** mode is transmit-only and never listens to the radio, as competition rules
  require. **Non-competition** mode listens for 400 ms after each packet, so the ground station can turn the buzzer on.
  Set it over USB before the flight; it's saved on the board.
- **Beep after landing**: an on/off switch for the rocket's own landing beeps. Works in competition mode, since
  nothing is sent to the rocket.
- **Buzzer**: "Buzz rocket" (non-competition launches only) from the app or the ground station's PRG button,
  confirmed by the rocket's next packets. Over USB, a beep test works in either mode.
- **Signal**: bars, link margin, RSSI, SNR, packet loss and a warmer/colder trend; the Signal tab adds history and a
  range test (link margin against distance, with a CSV export).
- **Walk to the rocket**: distance and bearing from the ground station's GPS (or the phone's), with a turn-by-turn arrow
  from the phone compass or your walking direction.
- **Alerts**: liftoff, apogee, landing, signal lost and low battery pop up on screen. Flight summary after landing.
- **Terminal**, **Flash** and **Code** tabs: raw board output with a command box, browser flashing, and the firmware
  source and protocol.

The app talks to the ground station over USB (Web Serial) or Bluetooth LE, and to the flight unit over USB. Install it
from the address bar ("Install app") to use it like a normal app. After the first visit it works offline, and map
tiles you've already viewed are kept, so open the map over your launch site before you leave home. Packets and the last
fix are kept in the browser, so a refresh doesn't lose the flight.

## Mac app

`desktop/` wraps the same app as a normal Mac app ("Rocket Tracker" in Applications, its own window and Dock
icon). Everything is bundled, so it runs with no internet except for new map tiles, and USB and Bluetooth work the
same as in Chrome. Build and install it with `cd desktop && ./build.sh --install` (see [desktop/README.md](desktop/README.md)).

## How the tracker works

```
L76K GPS ──serial──▶ XIAO ESP32S3 ──SPI──▶ Wio-SX1262 ──LoRa 915 MHz──▶ Heltec Wireless Tracker ──USB──▶ this app
          (in the rocket, transmit only)                                   (ground station, in your hand)
```

The flight unit sends a 23-byte packet once a second. In competition mode it never receives anything, so
nothing outside the rocket can control it after liftoff. The ground station receives each packet,
compares it with its own GPS, and sends both to the app over USB and Bluetooth. Its own screen
shows distance and bearing too, so the phone or laptop is never the only way to find the rocket.

## Repository

| Path | What it is |
|---|---|
| `firmware/flight-unit/` | Rocket firmware (PlatformIO). `bench` build = 2 dBm, `xiao_esp32s3` = 22 dBm |
| `firmware/ground-station/` | Heltec Wireless Tracker firmware |
| `firmware/flash.sh` | Build/flash/monitor from the command line instead of the app |
| `scripts/build-firmware.sh` | Builds all three firmware images for the app's Flash tab |
| `web/` | The app (Vite + React + TypeScript, Leaflet, esptool-js) |
| `desktop/` | The Mac app: Electron around the built `web/` app |
| `.github/workflows/deploy.yml` | On every push: build firmware, test, build the app, publish to GitHub Pages |

## Run it locally

```bash
./scripts/build-firmware.sh   # needs PlatformIO (pip install platformio)
cd web && npm install && npm run dev
```

Open http://localhost:5173. Web Serial works on `localhost` too.

## Privacy

Nothing leaves your browser. The launch site you set and the last rocket position are stored
only in your browser's local storage. The repo contains no keys, accounts or real locations;
the tests and default map use Great Meadow, VA as an example site.

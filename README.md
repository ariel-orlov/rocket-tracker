# Rocket Tracker

A GPS tracker for rocket launches, and the web app that shows it live.

**App:** https://ariel-orlov.github.io/rocket-tracker/ (Chrome or Edge on a computer)

- **Live**: the rocket on a satellite map, its flight path, flight state (pad / flight / landed),
  altitude, and the distance and compass bearing to walk from you to the rocket.
- **Terminal**: everything the board prints over USB, with filtering and a log download.
- **Flash**: load the firmware onto a board straight from the browser. No Arduino IDE needed.
- **Code**: the firmware source, plus the packet format and radio settings.
- **Simulate flight**: a realistic 800 ft flight with wind drift, to try everything without hardware.

The app talks to the boards with the browser's Web Serial API, so it needs Chrome or Edge on a
desktop or laptop. Install it from the address bar ("Install app") to use it like a normal app.
After the first visit it works offline, and map tiles you've already viewed are kept, so open
the map over your launch site before you leave home.

## How the tracker works

```
L76K GPS ──serial──▶ XIAO ESP32S3 ──SPI──▶ Wio-SX1262 ──LoRa 915 MHz──▶ Heltec Wireless Tracker ──USB──▶ this app
          (in the rocket, transmit only)                                   (ground station, in your hand)
```

The flight unit sends a 22-byte packet once a second and never receives anything, so nothing
outside the rocket can control it after liftoff. The ground station receives each packet,
compares it with its own GPS, and prints both over USB. The ground station's own screen shows
distance and bearing too, so the laptop is never the only way to find the rocket.

## Repository

| Path | What it is |
|---|---|
| `firmware/flight-unit/` | Rocket firmware (PlatformIO). `bench` build = 2 dBm, `xiao_esp32s3` = 22 dBm |
| `firmware/ground-station/` | Heltec Wireless Tracker firmware |
| `firmware/flash.sh` | Build/flash/monitor from the command line instead of the app |
| `scripts/build-firmware.sh` | Builds all three firmware images for the app's Flash tab |
| `web/` | The app (Vite + React + TypeScript, Leaflet, esptool-js) |
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
the simulator and tests use Great Meadow, VA as an example site.

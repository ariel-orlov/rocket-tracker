# Rocket Tracker for Mac

The same app as the website, as a normal Mac app: its own window and Dock icon, and it runs with
no internet (only map tiles need a connection, and tiles you've looked at are kept). USB and
Bluetooth work the same as in Chrome; when there's one board plugged in it connects straight away.

```bash
../scripts/build-firmware.sh   # optional: puts the firmware in the app's Flash tab (needs PlatformIO)
./build.sh --install           # builds "Rocket Tracker.app" and copies it to /Applications
```

`npm start` runs it without packaging (after `../web` has been built into `app/` by `./build.sh`).
The first Bluetooth connection asks for permission; it's in System Settings → Privacy & Security → Bluetooth.

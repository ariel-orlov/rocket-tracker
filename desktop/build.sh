#!/usr/bin/env bash
# Build "Rocket Tracker.app" for this Mac. ./build.sh --install also copies it to /Applications.
# Firmware for the Flash tab comes from ../scripts/build-firmware.sh (run it first, needs PlatformIO).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
ARCH="$(uname -m)"
NAME="Rocket Tracker"
OUT="$HERE/out/$NAME-darwin-$ARCH/$NAME.app"

[[ -d node_modules/electron ]] || npm install
[[ -f node_modules/electron/path.txt ]] || node node_modules/electron/install.js   # Electron's own binary
[[ -f ../web/public/firmware/manifest.json ]] || echo ">>> No firmware builds: the Flash tab will be empty. Run ../scripts/build-firmware.sh first."

echo ">>> Building the web app into app/"
(cd ../web && npm run build -- --outDir "$HERE/app" --emptyOutDir)

echo ">>> Icon"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
qlmanage -t -s 1024 -o "$(dirname "$ICONSET")" build/icon.svg >/dev/null 2>&1
SRC="$(dirname "$ICONSET")/icon.svg.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns

echo ">>> Packaging"
npx @electron/packager . "$NAME" --platform=darwin --arch="$ARCH" --out=out --overwrite --asar \
  --icon=build/icon.icns --app-bundle-id=io.github.ariel-orlov.rocket-tracker --app-version=2.0.0 \
  --extend-info=build/extra-info.plist --ignore='^/out' --ignore='^/build' --ignore='^/build\.sh' --ignore='^/README\.md'

# Renaming the bundle and adding the Bluetooth/location notes breaks Electron's signature;
# an ad-hoc signature is enough to run it on this Mac.
codesign --force --deep --sign - "$OUT"
codesign --verify --deep --strict "$OUT" && echo ">>> Signed (ad-hoc): $OUT"

if [[ "${1:-}" == "--install" ]]; then
  DEST="/Applications/$NAME.app"
  if [[ -e "$DEST" ]] && ! defaults read "$DEST/Contents/Info" CFBundleIdentifier 2>/dev/null | grep -q rocket-tracker; then
    echo ">>> $DEST exists and isn't this app. Not touching it."; exit 1
  fi
  rm -rf "$DEST"
  ditto "$OUT" "$DEST"
  echo ">>> Installed: $DEST"
fi

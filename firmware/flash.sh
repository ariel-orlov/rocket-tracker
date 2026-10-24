#!/bin/bash
# Build, flash and watch the rocket tracker firmware.
#   ./flash.sh bench     flight unit at 2 dBm (desk tests)
#   ./flash.sh flight    flight unit at 22 dBm (range test, launch)
#   ./flash.sh ground    Heltec ground station
#   ./flash.sh monitor   just open the serial monitor
# Add "build" as a second word to compile without uploading: ./flash.sh bench build
# Build files go to ~/.cache/rocket-tracker so the source folders stay clean.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HOME/.cache/rocket-tracker"

case "${1:-}" in
  bench)   PROJ=flight-unit;    ENV=bench ;;
  flight)  PROJ=flight-unit;    ENV=xiao_esp32s3 ;;
  ground)  PROJ=ground-station; ENV=heltec_wireless_tracker ;;
  monitor) exec pio device monitor -b 115200 ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

export PLATFORMIO_WORKSPACE_DIR="$CACHE/$PROJ"
if [[ "${2:-}" == "build" ]]; then
  pio run -d "$HERE/$PROJ" -e "$ENV"
  exit
fi

echo ">>> Antenna attached to the LoRa (Wio) connector? Ctrl-C now if not."
sleep 3
pio run -d "$HERE/$PROJ" -e "$ENV" -t upload
echo ">>> Flashed. Opening serial monitor (Ctrl-C to quit)."
sleep 2
pio device monitor -b 115200

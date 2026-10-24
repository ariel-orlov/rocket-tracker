#!/usr/bin/env bash
# Compile the three firmware builds and merge each into one image at address 0,
# so the web app's Flash tab can write a single file. Output: web/public/firmware/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/public/firmware"
PIO_HOME="${PLATFORMIO_CORE_DIR:-$HOME/.platformio}"
ESPTOOL="${ESPTOOL:-$PIO_HOME/packages/tool-esptool/esptool}"
BOOT_APP0="$PIO_HOME/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"
mkdir -p "$OUT"
entries=()

build() { # name project env
  local name=$1 proj=$2 env=$3
  pio run -d "$ROOT/firmware/$proj" -e "$env"
  local b="$ROOT/firmware/$proj/.pio/build/$env"
  "$ESPTOOL" --chip esp32s3 merge-bin -o "$OUT/$name.bin" \
    0x0 "$b/bootloader.bin" 0x8000 "$b/partitions.bin" 0xe000 "$BOOT_APP0" 0x10000 "$b/firmware.bin"
  local bytes sha
  bytes=$(wc -c < "$OUT/$name.bin" | tr -d ' ')
  sha=$(shasum -a 256 "$OUT/$name.bin" | cut -d' ' -f1)
  entries+=("\"$name\": {\"file\": \"$name.bin\", \"bytes\": $bytes, \"sha256\": \"$sha\"}")
}

build bench  flight-unit    bench
build flight flight-unit    xiao_esp32s3
build ground ground-station heltec_wireless_tracker

commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo local)
{
  echo "{"
  echo "  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"commit\": \"$commit\","
  echo "  \"targets\": {"
  (IFS=$'\n'; printf '    %s,\n' "${entries[@]}" | sed '$ s/,$//')
  echo "  }"
  echo "}"
} > "$OUT/manifest.json"
cat "$OUT/manifest.json"

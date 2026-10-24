import { ESPLoader, Transport } from "esptool-js";
import { releaseForFlashing } from "./serial";

export interface Target {
  id: "bench" | "flight" | "ground";
  name: string;
  board: string;
  note: string;
}

export const TARGETS: Target[] = [
  { id: "bench", name: "Flight unit: bench", board: "XIAO ESP32S3 + Wio-SX1262", note: "Transmits at 2 dBm. Use for desk tests." },
  { id: "flight", name: "Flight unit: flight", board: "XIAO ESP32S3 + Wio-SX1262", note: "Transmits at 22 dBm. Use for range tests and launches." },
  { id: "ground", name: "Ground station", board: "Heltec Wireless Tracker", note: "Receives packets, shows distance and bearing." },
];

export interface FirmwareManifest {
  builtAt: string;
  commit: string;
  targets: Record<string, { file: string; bytes: number; sha256: string }>;
}

export async function loadManifest(): Promise<FirmwareManifest | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}firmware/manifest.json`, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as FirmwareManifest) : null;
  } catch {
    return null;
  }
}

/**
 * Write the merged image (bootloader + partitions + app, built by CI) at address 0.
 * Asks the browser for the port itself, so the user picks the board in Chrome's dialog.
 */
export async function flashTarget(
  target: Target,
  manifest: FirmwareManifest,
  log: (s: string) => void,
  progress: (fraction: number) => void,
): Promise<void> {
  const entry = manifest.targets[target.id];
  if (!entry) throw new Error(`No ${target.name} build in this version of the app.`);
  const res = await fetch(`${import.meta.env.BASE_URL}firmware/${entry.file}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't download the firmware (${res.status}).`);
  const data = new Uint8Array(await res.arrayBuffer());
  log(`Downloaded ${entry.file} (${(data.length / 1024).toFixed(0)} KB).`);

  await releaseForFlashing();
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    terminal: { clean: () => undefined, writeLine: (s) => log(s), write: (s) => log(s) },
  });
  try {
    const chip = await loader.main();
    log(`Found ${chip}.`);
    if (!/ESP32-S3/i.test(chip)) throw new Error(`Expected an ESP32-S3, found ${chip}. Wrong board?`);
    await loader.writeFlash({
      fileArray: [{ data, address: 0 }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) => progress(written / total),
    });
    log("Write verified. Restarting the board…");
    await loader.after("hard_reset");
  } finally {
    await transport.disconnect().catch(() => undefined);
  }
}

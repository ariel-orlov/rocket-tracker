import { getState, ingestLine, logApp, resetLinkState, setState } from "./store";

export const serialSupported = typeof navigator !== "undefined" && "serial" in navigator;

let port: SerialPort | null = null;
let reader: ReadableStreamDefaultReader<string> | null = null;
let pipeDone: Promise<void> | null = null;
let wantConnected = false; // true while the user expects a live USB link
let portInfo: SerialPortInfo | null = null;
const encoder = new TextEncoder();

async function open(p: SerialPort) {
  await p.open({ baudRate: 115200 });
  port = p;
  portInfo = p.getInfo();
  setState({ conn: "usb", connError: null });
  void readLoop(p);
  // Firmware 3 answers with its info line (mode, version). Older firmware ignores it.
  setTimeout(() => void writeSerial("INFO").catch(() => undefined), 1200);
}

async function readLoop(p: SerialPort) {
  if (!p.readable) return;
  const decoder = new TextDecoderStream();
  pipeDone = p.readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => undefined);
  reader = decoder.readable.getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) ingestLine(line);
      }
      if (buf.length > 4096) buf = ""; // garbage with no newlines
    }
  } catch {
    /* device unplugged or reset: handled by the disconnect event */
  } finally {
    reader?.releaseLock();
    reader = null;
  }
}

export async function connectSerial(beforeOpen?: () => Promise<void>) {
  if (!serialSupported) {
    setState({ conn: "error", connError: "This browser can't open USB serial ports. Use Chrome or Edge on a computer." });
    return;
  }
  try {
    setState({ conn: "connecting", connError: null });
    const p = await navigator.serial.requestPort();
    await beforeOpen?.();
    wantConnected = true;
    resetLinkState();
    await open(p);
    logApp("Connected over USB. Waiting for data…");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Closing the picker without choosing is not an error worth shouting about.
    if (/No port selected/i.test(msg)) setState({ conn: "idle" });
    else setState({ conn: "error", connError: friendlyOpenError(msg) });
  }
}

function friendlyOpenError(msg: string) {
  if (/Failed to open|already open|in use/i.test(msg))
    return "The port is busy. Close Arduino IDE's Serial Monitor (or any other program using the board) and try again.";
  return msg;
}

export async function disconnectSerial() {
  wantConnected = false;
  await closePort();
  if (getState().conn === "usb" || getState().conn === "connecting") setState({ conn: "idle" });
  logApp("Disconnected.");
}

async function closePort() {
  try {
    await reader?.cancel();
  } catch {
    /* already gone */
  }
  try {
    await pipeDone;
  } catch {
    /* ignore */
  }
  try {
    await port?.close();
  } catch {
    /* already closed */
  }
  port = null;
}

/** One command line to the board. */
export async function writeSerial(line: string) {
  if (!port?.writable) throw new Error("Not connected over USB.");
  const w = port.writable.getWriter();
  try {
    await w.write(encoder.encode(line + "\n"));
  } finally {
    w.releaseLock();
  }
}

/** Same reset the Arduino IDE does: pulse RTS. The board drops off USB and comes back. */
export async function resetBoard() {
  if (!port) return;
  logApp("Resetting the board…");
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await new Promise((r) => setTimeout(r, 100));
  await port.setSignals({ requestToSend: false });
}

export function serialActive() {
  return port !== null;
}

// The XIAO's USB port disappears for a moment whenever it resets. Reopen it automatically
// so a reset or a bumped cable at the launch field doesn't need a click.
if (serialSupported) {
  navigator.serial.addEventListener("disconnect", (e) => {
    if ((e.target as SerialPort) !== port) return;
    port = null;
    if (wantConnected) {
      setState({ conn: "connecting" });
      logApp("USB link dropped. Reconnecting when the board comes back…");
    }
  });
  navigator.serial.addEventListener("connect", async (e) => {
    if (!wantConnected || port) return;
    const p = e.target as SerialPort;
    const info = p.getInfo();
    // Bootloader and app mode have different USB IDs on the ESP32-S3, so match on the vendor only.
    if (portInfo && info.usbVendorId !== undefined && portInfo.usbVendorId !== undefined) {
      const sameFamily = info.usbVendorId === portInfo.usbVendorId || info.usbVendorId === 0x303a || info.usbVendorId === 0x2886;
      if (!sameFamily) return;
    }
    try {
      await new Promise((r) => setTimeout(r, 300));
      await open(p);
      logApp("Reconnected.");
    } catch (err) {
      setState({ conn: "error", connError: friendlyOpenError(err instanceof Error ? err.message : String(err)) });
    }
  });
}

/** Release the port so the flasher can use it. */
export async function releaseForFlashing() {
  if (port) {
    wantConnected = false;
    await closePort();
    setState({ conn: "idle" });
    logApp("Released the USB port for flashing.");
  }
}

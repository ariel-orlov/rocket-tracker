import { getState, ingestLine, logApp, resetLinkState, setState } from "./store";

// Nordic UART service: the ground station notifies text lines on TX and takes commands on RX.
const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export const bleSupported = typeof navigator !== "undefined" && "bluetooth" in navigator;

let device: BluetoothDevice | null = null;
let rxChar: BluetoothRemoteGATTCharacteristic | null = null;
let wantConnected = false;
let buf = "";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function onData(e: Event) {
  const v = (e.target as BluetoothRemoteGATTCharacteristic).value;
  if (!v) return;
  buf += decoder.decode(v, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line.trim()) ingestLine(line);
  }
  if (buf.length > 4096) buf = "";
}

async function openGatt(d: BluetoothDevice) {
  const server = await d.gatt!.connect();
  const svc = await server.getPrimaryService(NUS);
  const tx = await svc.getCharacteristic(NUS_TX);
  rxChar = await svc.getCharacteristic(NUS_RX);
  buf = "";
  tx.addEventListener("characteristicvaluechanged", onData);
  await tx.startNotifications();
  setState({ conn: "ble", connError: null });
  setTimeout(() => void writeBle("INFO").catch(() => undefined), 500);
}

// Walking out of range drops the link. Keep trying for a minute so it comes back on its own.
async function onDisconnected() {
  rxChar = null;
  if (!wantConnected || !device) {
    if (getState().conn === "ble") setState({ conn: "idle" });
    return;
  }
  setState({ conn: "connecting" });
  logApp("Bluetooth link dropped. Reconnecting…");
  for (let attempt = 1; attempt <= 12 && wantConnected; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * attempt)));
    if (!wantConnected) return;
    try {
      await openGatt(device);
      logApp("Bluetooth reconnected.");
      return;
    } catch {
      /* still out of range */
    }
  }
  if (wantConnected) {
    wantConnected = false;
    setState({ conn: "error", connError: "Lost the Bluetooth link to the ground station. Move closer and press Connect again." });
  }
}

export async function connectBle(beforeOpen?: () => Promise<void>) {
  if (!bleSupported) {
    setState({ conn: "error", connError: "This browser has no Bluetooth. Use Chrome on a computer or Android (on iPhone, the Bluefy browser)." });
    return;
  }
  try {
    setState({ conn: "connecting", connError: null });
    const d = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS] }, { namePrefix: "Rocket Tracker" }],
      optionalServices: [NUS],
    });
    await beforeOpen?.();
    device?.removeEventListener("gattserverdisconnected", onDisconnected);
    device = d;
    d.addEventListener("gattserverdisconnected", onDisconnected);
    wantConnected = true;
    resetLinkState();
    await openGatt(d);
    logApp(`Connected to ${d.name ?? "the ground station"} over Bluetooth. Waiting for data…`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/cancelled|chooser|User cancel/i.test(msg)) setState({ conn: "idle" });
    else setState({ conn: "error", connError: `Bluetooth: ${msg}` });
  }
}

export async function disconnectBle() {
  wantConnected = false;
  device?.gatt?.disconnect();
  rxChar = null;
  if (getState().conn === "ble" || getState().conn === "connecting") setState({ conn: "idle" });
  logApp("Disconnected.");
}

export async function writeBle(line: string) {
  if (!rxChar) throw new Error("Not connected over Bluetooth.");
  const data = encoder.encode(line + "\n");
  // Commands are short; 20 bytes fits even the smallest Bluetooth packet.
  for (let i = 0; i < data.length; i += 20) {
    const part = data.slice(i, i + 20);
    if (rxChar.properties.writeWithoutResponse) await rxChar.writeValueWithoutResponse(part);
    else await rxChar.writeValueWithResponse(part);
  }
}

export function bleActive() {
  return rxChar !== null;
}

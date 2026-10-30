import { useEffect, useState } from "react";
import { getState, setState, subscribe } from "./store";

// ---------- keep the screen on while connected ----------
let lock: WakeLockSentinel | null = null;
async function syncWakeLock() {
  const s = getState();
  const want = s.settings.keepAwake && (s.conn === "usb" || s.conn === "ble") && document.visibilityState === "visible";
  try {
    if (want && !lock && "wakeLock" in navigator) {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = null));
    } else if (!want && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    /* low battery mode or not allowed: the screen just sleeps as usual */
  }
}
export function startWakeLock() {
  subscribe(() => void syncWakeLock());
  document.addEventListener("visibilitychange", () => void syncWakeLock());
}

// ---------- this device's location, for when the ground station has no GPS fix ----------
let watchId: number | null = null;
export function watchDeviceLocation(onError: (msg: string) => void) {
  if (!navigator.geolocation) return onError("This browser has no location access.");
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (p) =>
      setState({
        deviceLoc: {
          t: Date.now(), lat: p.coords.latitude, lon: p.coords.longitude, altM: p.coords.altitude, src: "browser",
          courseDeg: p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
          speedMps: p.coords.speed,
        },
      }),
    (e) => onError(e.message),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 },
  );
}
export function stopDeviceLocation() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setState({ deviceLoc: null });
}
export const deviceLocationOn = () => watchId !== null;

// ---------- phone compass: which way you're facing ----------
type OrientationEventIOS = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionAPI = { requestPermission?: () => Promise<"granted" | "denied"> };

let heading: number | null = null;
const headingListeners = new Set<(h: number | null) => void>();
let compassOn = false;

function onOrientation(e: Event) {
  const o = e as OrientationEventIOS;
  let h: number | null = null;
  if (typeof o.webkitCompassHeading === "number") h = o.webkitCompassHeading;
  else if (o.absolute && o.alpha !== null) h = (360 - o.alpha) % 360;
  if (h === null) return;
  // Correct for the screen being turned sideways.
  const angle = screen.orientation?.angle ?? 0;
  heading = (h + angle + 360) % 360;
  headingListeners.forEach((l) => l(heading));
}

export const compassSupported = typeof window !== "undefined" && "DeviceOrientationEvent" in window && navigator.maxTouchPoints > 0;

/** Must be called from a tap: iPhones ask for permission. */
export async function startCompass(): Promise<string | null> {
  if (compassOn) return null;
  const req = (DeviceOrientationEvent as unknown as PermissionAPI).requestPermission;
  if (req) {
    const r = await req().catch(() => "denied" as const);
    if (r !== "granted") return "Compass permission was denied.";
  }
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
  compassOn = true;
  return null;
}
export function stopCompass() {
  window.removeEventListener("deviceorientationabsolute", onOrientation);
  window.removeEventListener("deviceorientation", onOrientation);
  compassOn = false;
  heading = null;
  headingListeners.forEach((l) => l(null));
}

export function useHeading(): number | null {
  const [h, setH] = useState(heading);
  useEffect(() => {
    headingListeners.add(setH);
    return () => void headingListeners.delete(setH);
  }, []);
  return h;
}

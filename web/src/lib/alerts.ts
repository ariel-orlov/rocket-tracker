import { addEvent, getState } from "./store";

/**
 * Watches for the radio link going quiet. Events show as on-screen toasts and in the
 * flight log; the app makes no sound.
 */
let wasLive = false;
let linkLostAt: number | null = null;

export function startAlerts() {
  // 10 s of silence while connected = lost; the first packet after = back.
  window.setInterval(() => {
    const st = getState();
    const latest = st.samples[st.samples.length - 1];
    const connected = st.conn === "usb" || st.conn === "ble";
    const age = latest ? Date.now() - latest.t : Infinity;
    const live = connected && age < 10000;
    if (wasLive && !live && connected && linkLostAt === null) {
      linkLostAt = Date.now();
      addEvent("signal-lost", "Signal lost: no packets for 10 s");
    }
    if (live && linkLostAt !== null) {
      const gap = Math.round((Date.now() - linkLostAt) / 1000) + 10;
      linkLostAt = null;
      addEvent("signal-back", `Signal back after ${gap} s`);
    }
    if (!connected) linkLostAt = null;
    wasLive = live;
  }, 1000);
}

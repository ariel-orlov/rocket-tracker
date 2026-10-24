import { distanceM, offset } from "./geo";
import { clearSession, getState, ingestLine, logApp, setState } from "./store";

/**
 * Pretends to be the ground station: prints the same CSV lines and ME lines over a
 * realistic F42 flight to ~244 m (800 ft), so every screen can be tested without hardware.
 *
 *   0–4 s     GPS searching, no fix
 *   4–14 s    fix, waiting for 10 s of good fixes
 *   14–20 s   PAD-READY
 *   20 s      liftoff. GPS loses lock under boost for ~4 s (real L76K behaviour)
 *   27 s      apogee ~244 m, ejection at 28.5 s
 *   ~62 s     touchdown after drifting downwind under the chute
 *   ~77 s     LANDED (still for 15 s); packets slow to every 3 s
 */
const T_LAUNCH = 20;
const APOGEE_M = 244;
const T_APOGEE = 7; // after liftoff
const T_EJECT = 8.5;
const DESCENT_MPS = 7;
const PAD_ALT_MSL = 120;

let timer: number | null = null;

export function simRunning() {
  return timer !== null;
}

export function stopSim() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  if (getState().conn === "sim") setState({ conn: "idle" });
  logApp("Simulation stopped.");
}

const noise = (a: number) => (Math.random() * 2 - 1) * a;

export function startSim() {
  if (timer !== null) stopSim();
  const { site, simSpeed, windMps, windFromDeg } = getState().settings;
  const windTo = ((windFromDeg + 180) % 360) * (Math.PI / 180); // drift goes downwind
  const windN = Math.cos(windTo) * windMps;
  const windE = Math.sin(windTo) * windMps;
  const [opLat, opLon] = offset(site.lat, site.lon, -30, -25); // you, ~40 m from the pad

  let t = 0; // sim seconds
  let seq = 0;
  let nextTx = 0;
  let nextMe = 0;
  let posN = 0, posE = 0; // rocket offset from pad, m
  let lastFixN = 0, lastFixE = 0, lastFixAlt = PAD_ALT_MSL;
  let maxAgl = 0;
  let landedAt: number | null = null;
  let landedState = false;
  let batt = 4150;

  clearSession(); // each simulated flight starts from a clean slate
  setState({ conn: "sim", connError: null, radio: "ok", radioMsg: null });
  logApp(`Simulation started at ${site.name}, ${simSpeed}× speed, wind ${windMps} m/s from ${windFromDeg}°.`);
  ingestLine("seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,maps");

  const STEP = 0.25; // sim seconds per tick
  timer = window.setInterval(() => {
    t += STEP;
    const tl = t - T_LAUNCH;

    // --- truth: where the rocket really is ---
    let agl = 0;
    if (tl > 0) {
      if (tl <= T_APOGEE) agl = APOGEE_M * (1 - (1 - tl / T_APOGEE) ** 2);
      else if (tl <= T_EJECT) agl = APOGEE_M - 4.9 * (tl - T_APOGEE) ** 2;
      else {
        const atEject = APOGEE_M - 4.9 * (T_EJECT - T_APOGEE) ** 2;
        agl = Math.max(0, atEject - DESCENT_MPS * (tl - T_EJECT));
      }
      if (agl === 0 && tl > T_EJECT && landedAt === null) landedAt = t;
      if (landedAt === null) {
        const drift = tl > T_EJECT ? 1 : 0.25; // full wind drift once under the chute
        posN += windN * drift * STEP;
        posE += windE * drift * STEP;
      }
    }

    // --- what the GPS reports ---
    const sats = t < 4 ? Math.floor(t) : Math.min(13, 6 + Math.floor((t - 4) / 2));
    const boostDropout = tl > 0 && tl < 4;
    const hasFix = t >= 4;
    const fresh = hasFix && !boostDropout;
    if (fresh) {
      lastFixN = posN + noise(1.5);
      lastFixE = posE + noise(1.5);
      lastFixAlt = PAD_ALT_MSL + agl + noise(1.5);
      maxAgl = Math.max(maxAgl, lastFixAlt - PAD_ALT_MSL);
    }

    // --- flight state, mirroring the firmware's rules ---
    // Launch is only noticed once the GPS relocks above pad + 30 m; landing after 15 s still.
    let state = hasFix && t >= 14 ? "PAD-READY" : "PAD-NOFIX";
    if (tl > 0 && !boostDropout) state = "FLIGHT";
    if (landedAt !== null && t - landedAt >= 15) landedState = true;
    if (landedState) state = "LANDED";

    // --- transmit ---
    const interval = landedState ? 3 : 1;
    if (t >= nextTx) {
      nextTx = t + interval;
      batt -= 0.4;
      const [lat, lon] = hasFix ? offset(site.lat, site.lon, lastFixN, lastFixE) : [0, 0];
      const d3 = Math.hypot(distanceM(opLat, opLon, lat || site.lat, lon || site.lon), agl);
      const rssi = -32 - 20 * Math.log10(Math.max(d3, 1)) - (landedState ? 14 : 0) + noise(2);
      const snr = Math.max(-15, Math.min(12, (rssi + 118) / 3.5));
      const lost = rssi < -112 && Math.random() < 0.3;
      if (!lost) {
        const line = [
          seq, state, lat.toFixed(7), lon.toFixed(7), hasFix ? Math.round(lastFixAlt) : 0, sats, fresh ? 1 : 0,
          Math.round(batt), Math.round(Math.max(0, maxAgl)), rssi.toFixed(0), snr.toFixed(1),
          `https://maps.google.com/?q=${lat.toFixed(7)},${lon.toFixed(7)}`,
        ].join(",");
        ingestLine(line);
      }
      seq++;
    }
    if (t >= nextMe) {
      nextMe = t + 2;
      const [la, lo] = offset(opLat, opLon, noise(1.5), noise(1.5));
      ingestLine(`ME,${la.toFixed(7)},${lo.toFixed(7)},${PAD_ALT_MSL},9`);
    }

    if (landedAt !== null && t - landedAt > 120) stopSim();
  }, (STEP * 1000) / Math.max(0.25, simSpeed));
}

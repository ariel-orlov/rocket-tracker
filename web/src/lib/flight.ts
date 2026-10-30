import { bearingDeg, distanceM, offset } from "./geo";
import type { Sample } from "./types";

/** Least-squares slope of y over x. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const fixes = (samples: Sample[]) => samples.filter((s) => s.fresh && s.lat !== null && s.lon !== null && s.altM !== null);

/** Vertical speed in m/s from the fresh fixes of the last `windowMs` (needs 3). */
export function verticalSpeed(samples: Sample[], windowMs = 4000): number | null {
  const f = fixes(samples.slice(-12));
  if (f.length < 3) return null;
  const end = f[f.length - 1].t;
  const w = f.filter((s) => end - s.t <= windowMs);
  if (w.length < 3) return null;
  return slope(w.map((s) => s.t / 1000), w.map((s) => s.altM!));
}

export interface FlightSummary {
  liftoffT: number | null;
  apogeeAglM: number; // GPS estimate, not the scoring altimeter
  apogeeT: number | null;
  landedT: number | null; // when it stopped moving (the firmware says LANDED 15 s later)
  flightTimeS: number | null;
  descentMps: number | null; // under the chute, positive number
  pad: { lat: number; lon: number } | null;
  landing: { lat: number; lon: number } | null;
  driftM: number | null;
  driftBearing: number | null;
}

/** Everything worth knowing about the flight in this session, from the packets alone. */
export function summarize(samples: Sample[], padAltM: number | null): FlightSummary {
  const liftIdx = samples.findIndex((s) => s.state === "FLIGHT" || s.state === "LANDED");
  const liftoff = liftIdx >= 0 ? samples[liftIdx] : null;
  const padSample = [...samples.slice(0, liftIdx >= 0 ? liftIdx : samples.length)]
    .reverse()
    .find((s) => (s.state === "PAD-READY" || s.state === "PAD") && s.fresh && s.lat !== null);
  const pad = padSample ? { lat: padSample.lat!, lon: padSample.lon! } : null;
  const base = padAltM ?? padSample?.altM ?? null;

  const flight = liftIdx >= 0 ? fixes(samples.slice(liftIdx)) : [];
  let apogeeAglM = samples.reduce((m, s) => Math.max(m, s.maxAglM), 0);
  let apogeeT: number | null = null;
  if (base !== null && flight.length) {
    let top = flight[0];
    for (const s of flight) if (s.altM! > top.altM!) top = s;
    apogeeT = top.t;
    apogeeAglM = Math.max(apogeeAglM, top.altM! - base);
  }

  const landedIdx = samples.findIndex((s) => s.state === "LANDED");
  const landedSample = landedIdx >= 0 ? samples[landedIdx] : null;
  let landedT: number | null = null;
  if (landedSample) {
    // First fix after apogee that is within 10 m of the pad's height, else LANDED minus the 15 s wait.
    const down = base !== null ? flight.find((s) => apogeeT !== null && s.t > apogeeT && s.altM! - base < 10) : undefined;
    landedT = down ? down.t : landedSample.t - 15000;
  }

  let descentMps: number | null = null;
  if (apogeeT !== null && base !== null) {
    // Under the chute: from 5 s after apogee until 10 m above the ground.
    const d = flight.filter((s) => s.t > apogeeT! + 5000 && s.altM! - base > 10 && (landedT === null || s.t <= landedT));
    if (d.length >= 3) descentMps = -slope(d.map((s) => s.t / 1000), d.map((s) => s.altM!));
  }

  const lastFix = [...samples].reverse().find((s) => s.lat !== null && s.lon !== null);
  const landing = landedSample && lastFix ? { lat: lastFix.lat!, lon: lastFix.lon! } : null;
  return {
    liftoffT: liftoff?.t ?? null,
    apogeeAglM,
    apogeeT,
    landedT,
    flightTimeS: liftoff && landedT ? Math.max(0, (landedT - liftoff.t) / 1000) : null,
    descentMps: descentMps !== null && descentMps > 0 ? descentMps : null,
    pad,
    landing,
    driftM: pad && landing ? distanceM(pad.lat, pad.lon, landing.lat, landing.lon) : null,
    driftBearing: pad && landing ? bearingDeg(pad.lat, pad.lon, landing.lat, landing.lon) : null,
  };
}

/**
 * Where it will come down if it keeps drifting the way it is: current position plus the
 * horizontal velocity of the last few fixes times the time left to fall. Only while descending.
 */
export function predictLanding(samples: Sample[], padAltM: number | null): { lat: number; lon: number; inS: number; spreadM: number } | null {
  const last = samples[samples.length - 1];
  if (!last || last.state !== "FLIGHT" || padAltM === null) return null;
  const f = fixes(samples.slice(-10));
  if (f.length < 4) return null;
  const end = f[f.length - 1];
  if (last.t - end.t > 5000) return null; // no recent fix to extrapolate from
  const agl = end.altM! - padAltM;
  const vz = verticalSpeed(samples, 6000);
  if (vz === null || vz > -1 || agl < 5) return null;
  const inS = agl / -vz;
  const ts = f.map((s) => s.t / 1000);
  const north = f.map((s) => distanceM(end.lat!, end.lon!, s.lat!, end.lon!) * Math.sign(s.lat! - end.lat!));
  const east = f.map((s) => distanceM(end.lat!, end.lon!, end.lat!, s.lon!) * Math.sign(s.lon! - end.lon!));
  const vn = slope(ts, north), ve = slope(ts, east);
  const [lat, lon] = offset(end.lat!, end.lon!, vn * inS, ve * inS);
  // Wind changes on the way down; grow the circle with the distance still to drift.
  const spreadM = Math.max(15, 0.35 * Math.hypot(vn * inS, ve * inS));
  return { lat, lon, inS, spreadM };
}

/** Rough 1S LiPo state of charge from resting voltage. */
export function lipoPercent(mv: number): number {
  const curve: [number, number][] = [[3300, 0], [3600, 8], [3700, 20], [3750, 32], [3800, 45], [3850, 55], [3900, 63], [4000, 78], [4100, 90], [4200, 100]];
  if (mv <= curve[0][0]) return 0;
  for (let i = 1; i < curve.length; i++) {
    const [v1, p1] = curve[i];
    const [v0, p0] = curve[i - 1];
    if (mv <= v1) return Math.round(p0 + ((mv - v0) / (v1 - v0)) * (p1 - p0));
  }
  return 100;
}

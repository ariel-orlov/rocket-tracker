import { describe, expect, it } from "vitest";
import { linkMarginDb, packetLoss, quality, trend } from "./signal";
import { lipoPercent, predictLanding, summarize, verticalSpeed } from "./flight";
import { distanceM, offset } from "./geo";
import type { FlightState, Sample } from "./types";

const PAD = { lat: 38.885, lon: -77.7745, alt: 120 };

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t, src: "ground", seq: Math.round(t / 1000), state: "PAD-READY", lat: PAD.lat, lon: PAD.lon, altM: PAD.alt, sats: 10,
    fresh: true, battMv: 4100, maxAglM: 0, rssi: -60, snr: 9, flags: null, cfg: null, ...over,
  };
}

describe("signal", () => {
  it("measures link margin from RSSI above the noise floor and SNR below it", () => {
    expect(linkMarginDb(-60, 9)).toBe(68);
    expect(linkMarginDb(-120, -10)).toBe(7.5);
    // The two formulas meet near SNR 0 (about -111 dBm).
    expect(Math.abs(linkMarginDb(-111, 0) - linkMarginDb(-111, -0.01))).toBeLessThan(1);
    expect(quality(35).bars).toBe(4);
    expect(quality(5).bars).toBe(1);
  });

  it("counts lost packets from sequence gaps, across the 65535 wrap", () => {
    const w = [65533, 65534, 0, 2, 3].map((seq, i) => sample(i * 1000, { seq }));
    const l = packetLoss(w)!;
    expect(l.expected).toBe(7);
    expect(l.received).toBe(5);
    expect(l.lossPct).toBeCloseTo((2 / 7) * 100, 5);
  });

  it("says warmer when the signal climbs", () => {
    const now = 20000;
    const s = Array.from({ length: 20 }, (_, i) => sample(now - 19000 + i * 1000, { rssi: i < 10 ? -100 : -90, snr: 5 }));
    expect(trend(s, now)?.dir).toBe("warmer");
  });
});

/** A clean flight: 10 s on the pad, 7 s up to 244 m, chute at 6 m/s drifting east 4 m/s, landed. */
function flight(): Sample[] {
  const out: Sample[] = [];
  let t = 0;
  const push = (state: FlightState, agl: number, eastM: number, fresh = true) => {
    const [lat, lon] = offset(PAD.lat, PAD.lon, 0, eastM);
    out.push(sample(t, { state, lat, lon, altM: PAD.alt + agl, fresh, maxAglM: Math.max(0, ...out.map((s) => s.altM! - PAD.alt), agl) }));
    t += 1000;
  };
  for (let i = 0; i < 10; i++) push("PAD-READY", 0, 0);
  for (let i = 1; i <= 7; i++) push("FLIGHT", 244 * (1 - (1 - i / 7) ** 2), 0, i > 4);
  let agl = 244, east = 0;
  while (agl > 0) { agl = Math.max(0, agl - 6); east += 4; push("FLIGHT", agl, east); }
  for (let i = 0; i < 16; i++) push(i < 15 ? "FLIGHT" : "LANDED", 0, east);
  return out;
}

describe("flight", () => {
  it("finds apogee, descent rate, flight time and drift", () => {
    const f = summarize(flight(), PAD.alt);
    expect(f.apogeeAglM).toBeCloseTo(244, 0);
    expect(f.descentMps).toBeCloseTo(6, 0);
    expect(f.flightTimeS).toBeGreaterThan(45);
    expect(f.flightTimeS).toBeLessThan(55);
    expect(f.driftBearing).toBeCloseTo(90, 0);
    expect(f.driftM).toBeCloseTo(41 * 4, -1);
  });

  it("predicts the landing spot while descending", () => {
    const all = flight();
    const mid = all.findIndex((s) => s.state === "FLIGHT" && s.altM! - PAD.alt < 120 && s.t > 17000);
    const upTo = all.slice(0, mid + 1);
    const p = predictLanding(upTo, PAD.alt)!;
    const landing = all[all.length - 1];
    expect(p).not.toBeNull();
    expect(distanceM(p.lat, p.lon, landing.lat!, landing.lon!)).toBeLessThan(15);
    expect(verticalSpeed(upTo)).toBeCloseTo(-6, 0);
  });

  it("estimates LiPo charge", () => {
    expect(lipoPercent(4200)).toBe(100);
    expect(lipoPercent(3300)).toBe(0);
    expect(lipoPercent(3850)).toBe(55);
  });
});

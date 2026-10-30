import type { Sample } from "./types";

// SF11 at 500 kHz: LoRa decodes down to about −17.5 dB SNR, and the noise floor
// (−174 dBm/Hz + 57 dB for 500 kHz + ~6 dB noise figure) is about −111 dBm, so the
// receiver's sensitivity is about −128 dBm. Rough numbers from Semtech's tables.
export const SNR_LIMIT_DB = -17.5;
export const SENSITIVITY_DBM = -128;

/**
 * How many dB the signal could lose before packets stop. Above the noise floor (SNR ≥ 0)
 * RSSI tells you; below it, SNR does. The two agree at SNR = 0 (−111 dBm ≈ 17 dB).
 */
export function linkMarginDb(rssi: number, snr: number): number {
  return snr >= 0 ? rssi - SENSITIVITY_DBM : snr - SNR_LIMIT_DB;
}

export type Quality = { bars: 0 | 1 | 2 | 3 | 4; label: string; tone: "ok" | "warn" | "bad" };

export function quality(marginDb: number): Quality {
  if (marginDb >= 30) return { bars: 4, label: "Excellent", tone: "ok" };
  if (marginDb >= 20) return { bars: 3, label: "Good", tone: "ok" };
  if (marginDb >= 10) return { bars: 2, label: "Fair", tone: "warn" };
  if (marginDb >= 4) return { bars: 1, label: "Weak", tone: "bad" };
  return { bars: 0, label: "About to drop", tone: "bad" };
}

/** Packets that carry RSSI (from the ground station) within the last `windowMs`. */
export function radioSamples(samples: Sample[], now: number, windowMs: number): Sample[] {
  const out: Sample[] = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (now - s.t > windowMs) break;
    if (s.src === "ground" && s.rssi !== null && s.snr !== null) out.push(s);
  }
  return out.reverse();
}

/**
 * Share of packets lost, from gaps in the sequence numbers (they wrap at 65536).
 * A reboot of the rocket restarts the count, so a backwards jump starts a new run.
 */
export function packetLoss(window: Sample[]): { received: number; expected: number; lossPct: number } | null {
  if (window.length < 3) return null;
  let expected = 1;
  for (let i = 1; i < window.length; i++) {
    const step = (window[i].seq - window[i - 1].seq + 65536) % 65536;
    expected += step > 0 && step < 600 ? step : 1;
  }
  const received = window.length;
  return { received, expected, lossPct: Math.max(0, (1 - received / expected) * 100) };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Warmer/colder: link margin over the last 10 s against the 10 s before. Works even when
 * the rocket has no GPS fix, as long as packets get through.
 */
export function trend(samples: Sample[], now: number): { deltaDb: number; dir: "warmer" | "colder" | "same" } | null {
  const w = radioSamples(samples, now, 20000);
  const recent = w.filter((s) => now - s.t <= 10000).map((s) => linkMarginDb(s.rssi!, s.snr!));
  const before = w.filter((s) => now - s.t > 10000).map((s) => linkMarginDb(s.rssi!, s.snr!));
  if (recent.length < 2 || before.length < 2) return null;
  const deltaDb = mean(recent) - mean(before);
  return { deltaDb, dir: deltaDb > 2 ? "warmer" : deltaDb < -2 ? "colder" : "same" };
}

import type { FlightState, Sample } from "./types";

// Packet flags, identical to FLAG_* in both firmware files.
export const FLAG = { FIX: 0x01, FRESH: 0x02, PADSET: 0x04, FLIGHT: 0x08, LANDED: 0x10, LOWBATT: 0x20 } as const;

export function stateFromFlags(f: number): FlightState {
  if (f & FLAG.LANDED) return "LANDED";
  if (f & FLAG.FLIGHT) return "FLIGHT";
  if (f & FLAG.PADSET) return "PAD-READY";
  return "PAD-NOFIX";
}

export type Parsed =
  | { kind: "sample"; sample: Omit<Sample, "t"> }
  | { kind: "operator"; lat: number; lon: number; altM: number; sats: number }
  | { kind: "operator-nofix"; sats: number }
  | { kind: "status"; level: "ok" | "error" | "info"; text: string; device?: "flight" | "ground"; radio?: "ok" | "failed" }
  | { kind: "other" };

// Flight unit USB log:
// #12 st=0 fix=1 sats=9 38.8850000,-77.7745000 alt=120 agl_max=0 batt=4100 gps_chars=1035 bad=0 flags=07
const FLIGHT_RE =
  /^#(\d+) st=(\d) fix=([01]) sats=(\d+) (-?\d+\.\d+),(-?\d+\.\d+) alt=(-?\d+) agl_max=(\d+) batt=(\d+)(?: gps_chars=(\d+) bad=(\d+))?(?: flags=([0-9A-Fa-f]{1,2}))?\s*$/;

// Ground station CSV (header: seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,maps)
const GROUND_RE =
  /^(\d+),(PAD-NOFIX|PAD-READY|FLIGHT|LANDED),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+),(\d+),([01]),(\d+),(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,.*)?$/;

const ME_RE = /^ME,(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+),(\d+)\s*$/;
const ME_NOFIX_RE = /^ME,nofix,(\d+)\s*$/;

/** A 1S LiPo reads 3.0–4.3 V. Anything else is the floating pin before the divider is wired. */
function battOrNull(mv: number): number | null {
  return mv >= 2800 && mv <= 4350 ? mv : null;
}

function posOrNull(lat: number, lon: number, hasFix: boolean): [number | null, number | null] {
  if (!hasFix && lat === 0 && lon === 0) return [null, null];
  if (lat === 0 && lon === 0) return [null, null];
  return [lat, lon];
}

export function parseLine(raw: string): Parsed {
  const line = raw.trim();
  if (!line) return { kind: "other" };

  let m = FLIGHT_RE.exec(line);
  if (m) {
    const st = Number(m[2]);
    const fresh = m[3] === "1";
    const flags = m[12] !== undefined ? parseInt(m[12], 16) : null;
    const state: FlightState =
      flags !== null ? stateFromFlags(flags) : st === 2 ? "LANDED" : st === 1 ? "FLIGHT" : "PAD-NOFIX";
    const hasFix = flags !== null ? (flags & FLAG.FIX) !== 0 : fresh;
    const [lat, lon] = posOrNull(Number(m[5]), Number(m[6]), hasFix);
    return {
      kind: "sample",
      sample: {
        src: "flight",
        seq: Number(m[1]),
        state,
        lat,
        lon,
        altM: lat === null ? null : Number(m[7]),
        sats: Number(m[4]),
        fresh,
        battMv: battOrNull(Number(m[9])),
        maxAglM: Number(m[8]),
        rssi: null,
        snr: null,
        flags,
        gpsChars: m[10] !== undefined ? Number(m[10]) : undefined,
        badChecksums: m[11] !== undefined ? Number(m[11]) : undefined,
      },
    };
  }

  m = GROUND_RE.exec(line);
  if (m) {
    const [lat, lon] = posOrNull(Number(m[3]), Number(m[4]), true);
    return {
      kind: "sample",
      sample: {
        src: "ground",
        seq: Number(m[1]),
        state: m[2] as FlightState,
        lat,
        lon,
        altM: lat === null ? null : Number(m[5]),
        sats: Number(m[6]),
        fresh: m[7] === "1",
        battMv: battOrNull(Number(m[8])),
        maxAglM: Number(m[9]),
        rssi: Number(m[10]),
        snr: Number(m[11]),
        flags: null,
      },
    };
  }

  m = ME_RE.exec(line);
  if (m) return { kind: "operator", lat: Number(m[1]), lon: Number(m[2]), altM: Number(m[3]), sats: Number(m[4]) };
  m = ME_NOFIX_RE.exec(line);
  if (m) return { kind: "operator-nofix", sats: Number(m[1]) };

  if (line === "radio OK") return { kind: "status", level: "ok", text: line, radio: "ok" };
  m = /radio\.begin failed: (-?\d+)/.exec(line) ?? /RADIO FAIL (-?\d+)/.exec(line);
  if (m) return { kind: "status", level: "error", text: line, radio: "failed" };
  if (/^tx error/.test(line)) return { kind: "status", level: "error", text: line };
  if (/tracker flight unit$/i.test(line)) return { kind: "status", level: "info", text: line, device: "flight" };
  if (line.startsWith("seq,state,lat,lon")) return { kind: "status", level: "info", text: line, device: "ground" };
  if (line.startsWith("Last saved fix:")) return { kind: "status", level: "info", text: line, device: "ground" };

  return { kind: "other" };
}

/** What a radio.begin error code means, from RadioLib's error list. */
export function radioErrorHint(text: string): string | null {
  const code = /(-?\d+)\s*$/.exec(text)?.[1];
  if (code === "-2") return "Radio not answering on SPI: re-seat the Wio board until it clicks flat.";
  if (code && /^-70\d$/.test(code)) return "Oscillator voltage setting: change TCXO_VOLTS to 1.6 and reflash.";
  return null;
}

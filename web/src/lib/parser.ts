import type { CommandName, CommandStatus, FlightInfo, FlightState, GroundInfo, LinkStats, RocketCfg, Sample } from "./types";

// Packet flags and cfg bits, identical to FLAG_* / CFG_* in both firmware files.
export const FLAG = { FIX: 0x01, FRESH: 0x02, PADSET: 0x04, FLIGHT: 0x08, LANDED: 0x10, LOWBATT: 0x20 } as const;
export const CFG = { NONCOMP: 0x01, LANDBEEP: 0x02, BUZZING: 0x04, QUIET: 0x08 } as const;

export function stateFromFlags(f: number): FlightState {
  if (f & FLAG.LANDED) return "LANDED";
  if (f & FLAG.FLIGHT) return "FLIGHT";
  if (f & FLAG.PADSET) return "PAD-READY";
  return "PAD-NOFIX";
}

export function cfgFromByte(c: number): RocketCfg {
  return { nonComp: !!(c & CFG.NONCOMP), landBeep: !!(c & CFG.LANDBEEP), buzzing: !!(c & CFG.BUZZING), quiet: !!(c & CFG.QUIET) };
}

export type Parsed =
  | { kind: "sample"; sample: Omit<Sample, "t"> }
  | { kind: "operator"; lat: number; lon: number; altM: number; sats: number; courseDeg: number | null; speedMps: number | null; hdop?: number }
  | { kind: "operator-nofix"; sats: number }
  | { kind: "flight-info"; info: Omit<FlightInfo, "t"> }
  | { kind: "ground-info"; info: Omit<GroundInfo, "t"> }
  | { kind: "stats"; stats: Omit<LinkStats, "t"> }
  | { kind: "command"; status: Omit<CommandStatus, "t"> }
  | { kind: "saved-fix"; lat: number; lon: number }
  | { kind: "forgot" }
  | { kind: "status"; level: "ok" | "error" | "info"; text: string; device?: "flight" | "ground"; radio?: "ok" | "failed" }
  | { kind: "other" };

// Flight unit USB log:
// #12 st=0 fix=1 sats=9 38.8850000,-77.7745000 alt=120 agl_max=0 batt=4100 gps_chars=1035 bad=0 flags=07 cfg=02
const FLIGHT_RE =
  /^#(\d+) st=(\d) fix=([01]) sats=(\d+) (-?\d+\.\d+),(-?\d+\.\d+) alt=(-?\d+) agl_max=(\d+) batt=(\d+)(?: gps_chars=(\d+) bad=(\d+))?(?: flags=([0-9A-Fa-f]{1,2}))?(?: cfg=([0-9A-Fa-f]{1,2}))?\s*$/;

// Ground station CSV. Firmware 3 header: seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,flags,cfg,age_s,maps
// Firmware 2 had no flags, cfg or age_s (maps came right after snr).
const GROUND_RE =
  /^(\d+),(PAD-NOFIX|PAD-READY|FLIGHT|LANDED),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+),(\d+),([01]),(\d+),(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,([0-9A-Fa-f]{2}),([0-9A-Fa-f]{2}|--),(\d+(?:\.\d+)?))?(?:,.*)?$/;

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const ME_RE = new RegExp(`^ME,(-?\\d+\\.\\d+),(-?\\d+\\.\\d+),(-?\\d+),(\\d+)(?:,${NUM},${NUM},${NUM})?\\s*$`);
const ME_NOFIX_RE = /^ME,nofix,(\d+)\s*$/;
const CMD_RE = /^CMD,(sent|done|refused|failed|cancelled|txerror),([A-Z]+),(\d+)(?:,(.*))?$/;
const ACK_RE = /^ACK,([A-Z]+)(?:,([^,]*))?(?:,(\w+))?$/;

/** A 1S LiPo reads 3.0–4.3 V. Anything else is the floating pin before the divider is wired. */
function battOrNull(mv: number): number | null {
  return mv >= 2800 && mv <= 4350 ? mv : null;
}

function posOrNull(lat: number, lon: number, hasFix: boolean): [number | null, number | null] {
  if (!hasFix && lat === 0 && lon === 0) return [null, null];
  if (lat === 0 && lon === 0) return [null, null];
  return [lat, lon];
}

/** "a=1,b=two" → { a: "1", b: "two" } */
function keyValues(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const COMMANDS: CommandName[] = ["BUZZ", "LANDBEEP", "QUIET", "MODE", "BEEP"];
const asCommand = (s: string): CommandName | null => (COMMANDS.includes(s as CommandName) ? (s as CommandName) : null);

export function parseLine(raw: string): Parsed {
  const line = raw.trim();
  if (!line) return { kind: "other" };

  let m = FLIGHT_RE.exec(line);
  if (m) {
    const st = Number(m[2]);
    const fresh = m[3] === "1";
    const flags = m[12] !== undefined ? parseInt(m[12], 16) : null;
    // Older firmware has no flags, so pad readiness is unknown; a fresh fix still counts as a fix.
    const state: FlightState =
      flags !== null ? stateFromFlags(flags) : st === 2 ? "LANDED" : st === 1 ? "FLIGHT" : fresh ? "PAD" : "PAD-NOFIX";
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
        cfg: m[13] !== undefined ? cfgFromByte(parseInt(m[13], 16)) : null,
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
        flags: m[12] !== undefined ? parseInt(m[12], 16) : null,
        cfg: m[13] !== undefined && m[13] !== "--" ? cfgFromByte(parseInt(m[13], 16)) : null,
        fixAgeS: m[14] !== undefined ? Number(m[14]) : undefined,
      },
    };
  }

  m = ME_RE.exec(line);
  if (m) {
    const course = m[5] !== undefined ? Number(m[5]) : null;
    return {
      kind: "operator",
      lat: Number(m[1]),
      lon: Number(m[2]),
      altM: Number(m[3]),
      sats: Number(m[4]),
      courseDeg: course !== null && course >= 0 ? course : null,
      speedMps: m[6] !== undefined ? Number(m[6]) : null,
      hdop: m[7] !== undefined ? Number(m[7]) : undefined,
    };
  }
  m = ME_NOFIX_RE.exec(line);
  if (m) return { kind: "operator-nofix", sats: Number(m[1]) };

  if (line.startsWith("FU,")) {
    const kv = keyValues(line.slice(3));
    return {
      kind: "flight-info",
      info: {
        fw: Number(kv.fw ?? 0),
        team: kv.team ?? "",
        powerDbm: Number(kv.power ?? 0),
        nonComp: kv.mode === "NONCOMP",
        landBeep: kv.landbeep === "1",
        quiet: kv.quiet === "1",
        radioOk: kv.radio !== "failed",
      },
    };
  }
  if (line.startsWith("GS,")) {
    const kv = keyValues(line.slice(3));
    return {
      kind: "ground-info",
      info: {
        fw: Number(kv.fw ?? 0),
        team: kv.team ?? "",
        freqMhz: Number(kv.freq ?? 0),
        bwKhz: Number(kv.bw ?? 0),
        sf: Number(kv.sf ?? 0),
        ble: kv.ble === "1",
        name: kv.name ?? "",
      },
    };
  }
  if (line.startsWith("STAT,")) {
    const kv = keyValues(line.slice(5));
    return {
      kind: "stats",
      stats: { rx: Number(kv.rx ?? 0), crc: Number(kv.crc ?? 0), other: Number(kv.other ?? 0), upS: Number(kv.up ?? 0), ble: kv.ble === "1" },
    };
  }

  m = CMD_RE.exec(line);
  if (m) {
    const cmd = asCommand(m[2]);
    if (cmd) {
      const extra = m[4] ?? "";
      const tries = Number(/try=(\d+)/.exec(extra)?.[1] ?? 0);
      const phase = m[1] === "txerror" ? "sent" : (m[1] as CommandStatus["phase"]);
      const reason = m[1] === "txerror" ? `radio error ${extra}` : m[1] === "sent" ? undefined : extra || undefined;
      return { kind: "command", status: { cmd, arg: m[3], phase, reason, tries, via: "ground" } };
    }
  }
  m = ACK_RE.exec(line);
  if (m) {
    if (m[1] === "FORGET") return { kind: "forgot" };
    const cmd = asCommand(m[1]);
    // "queued" = the ground station will send it after the rocket's next packet.
    // "usb" = the flight unit did it. "radio" = the flight unit heard it from the ground station.
    if (cmd && m[3] !== "radio")
      return {
        kind: "command",
        status: { cmd, arg: m[2] ?? "", phase: m[3] === "queued" ? "queued" : "done", tries: 0, via: m[3] === "queued" ? "ground" : "usb" },
      };
    return { kind: "status", level: "ok", text: line };
  }
  if (line.startsWith("ERR,")) return { kind: "status", level: "error", text: line };

  m = /^Last saved fix: (-?\d+\.\d+),(-?\d+\.\d+)/.exec(line);
  if (m) return { kind: "saved-fix", lat: Number(m[1]), lon: Number(m[2]) };

  if (line === "radio OK") return { kind: "status", level: "ok", text: line, radio: "ok" };
  m = /radio\.begin failed: (-?\d+)/.exec(line) ?? /RADIO FAIL (-?\d+)/.exec(line);
  if (m) return { kind: "status", level: "error", text: line, radio: "failed" };
  if (/^tx error/.test(line)) return { kind: "status", level: "error", text: line };
  if (/tracker flight unit$/i.test(line)) return { kind: "status", level: "info", text: line, device: "flight" };
  if (line.startsWith("seq,state,lat,lon")) return { kind: "status", level: "info", text: line, device: "ground" };

  return { kind: "other" };
}

/** What a radio.begin error code means, from RadioLib's error list. */
export function radioErrorHint(text: string): string | null {
  const code = /(-?\d+)\s*$/.exec(text)?.[1];
  if (code === "-2") return "Radio not answering on SPI: re-seat the Wio board until it clicks flat.";
  if (code && /^-70\d$/.test(code)) return "Oscillator voltage setting: change TCXO_VOLTS to 1.6 and reflash.";
  return null;
}

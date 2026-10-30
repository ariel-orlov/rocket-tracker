export type FlightState = "PAD-NOFIX" | "PAD" | "PAD-READY" | "FLIGHT" | "LANDED";

/** The rocket's settings, sent in every packet by firmware 3 (the cfg byte). */
export interface RocketCfg {
  nonComp: boolean; // listens for ground commands after each packet. Not allowed on competition flights
  landBeep: boolean; // beeps by itself after landing
  buzzing: boolean; // buzzer on by command right now
  quiet: boolean; // pad chirps muted
}

/** One position packet, from either the flight unit's USB log or the ground station's CSV. */
export interface Sample {
  t: number; // receive time, ms since epoch
  src: "flight" | "ground";
  seq: number;
  state: FlightState;
  lat: number | null;
  lon: number | null;
  altM: number | null; // GPS altitude above sea level
  sats: number;
  fresh: boolean; // position updated in the last 3 s
  battMv: number | null; // null when the reading is not a real battery voltage
  maxAglM: number;
  rssi: number | null; // ground station only
  snr: number | null;
  flags: number | null;
  cfg: RocketCfg | null; // null = older firmware, unknown
  fixAgeS?: number;
  gpsChars?: number;
  badChecksums?: number;
}

/** Where the person holding the ground station is. */
export interface Operator {
  t: number;
  lat: number;
  lon: number;
  altM: number | null;
  src: "ground" | "browser";
  courseDeg: number | null; // direction of travel, when walking
  speedMps: number | null;
  sats?: number;
  hdop?: number;
}

/** From the flight unit's "FU,..." line (USB only). */
export interface FlightInfo {
  t: number;
  fw: number;
  team: string;
  powerDbm: number;
  nonComp: boolean;
  landBeep: boolean;
  quiet: boolean;
  radioOk: boolean;
}

/** From the ground station's "GS,..." line. */
export interface GroundInfo {
  t: number;
  fw: number;
  team: string;
  freqMhz: number;
  bwKhz: number;
  sf: number;
  ble: boolean;
  name: string;
}

/** From the ground station's "STAT,..." line, every 5 s. */
export interface LinkStats {
  t: number;
  rx: number; // good packets from our rocket
  crc: number; // heard but corrupted
  other: number; // someone else's LoRa traffic
  upS: number;
  ble: boolean;
}

export type CommandName = "BUZZ" | "LANDBEEP" | "QUIET" | "MODE" | "BEEP";

export interface CommandStatus {
  t: number;
  cmd: CommandName;
  arg: string;
  phase: "waiting" | "queued" | "sent" | "done" | "refused" | "failed" | "cancelled";
  reason?: string;
  tries: number;
  via: "ground" | "usb";
}

export interface FlightEvent {
  id: number;
  t: number;
  kind: "liftoff" | "apogee" | "landed" | "lowbatt" | "signal-lost" | "signal-back" | "buzzing";
  text: string;
}

export type LineKind = "packet" | "ok" | "error" | "info" | "app" | "cmd";

export interface TermLine {
  id: number;
  t: number;
  text: string;
  kind: LineKind;
}

export interface Site {
  name: string;
  lat: number;
  lon: number;
}

export interface Settings {
  units: "ft" | "m";
  layer: "street" | "satellite";
  site: Site;
  compFlight: boolean; // the next flight is an competition flight: non-competition mode fails the pre-flight check
  keepAwake: boolean;
}

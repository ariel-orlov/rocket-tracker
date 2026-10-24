export type FlightState = "PAD-NOFIX" | "PAD" | "PAD-READY" | "FLIGHT" | "LANDED";

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
}

export type LineKind = "packet" | "ok" | "error" | "info" | "app";

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
  simSpeed: number;
  windMps: number;
  windFromDeg: number;
}

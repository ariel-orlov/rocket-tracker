import { useSyncExternalStore } from "react";
import { FLAG, parseLine, radioErrorHint } from "./parser";
import type {
  CommandStatus, FlightEvent, FlightInfo, GroundInfo, LineKind, LinkStats, Operator, RocketCfg, Sample, Settings, TermLine,
} from "./types";
import { M_TO_FT } from "./geo";

export type Conn = "idle" | "connecting" | "usb" | "ble" | "error";

export interface AppState {
  conn: Conn;
  connError: string | null;
  device: "unknown" | "flight" | "ground";
  radio: "unknown" | "ok" | "failed";
  radioMsg: string | null;
  flightInfo: FlightInfo | null; // flight unit on USB
  groundInfo: GroundInfo | null;
  groundGps: { t: number; fix: boolean; sats: number } | null;
  stats: LinkStats[]; // last two, for rates
  command: CommandStatus | null;
  lines: TermLine[];
  samples: Sample[];
  events: FlightEvent[];
  operator: Operator | null; // from the ground station's GPS
  deviceLoc: Operator | null; // from this phone or laptop
  padAltM: number | null;
  lastFix: Sample | null; // newest sample with a position; kept across reloads
  groundSavedFix: { lat: number; lon: number } | null; // what the ground station has in flash
  settings: Settings;
}

// Default map site: Great Meadow, The Plains VA (a public launch field, approximate).
// Your own site is stored only in this browser.
export const DEFAULT_SITE = { name: "Great Meadow, VA", lat: 38.885, lon: -77.7745 };

const DEFAULT_SETTINGS: Settings = {
  units: "ft",
  layer: "satellite",
  site: DEFAULT_SITE,
  compFlight: true,
  keepAwake: true,
};

const MAX_LINES = 3000;
const MAX_SAMPLES = 20000;
const PERSIST_SAMPLES = 6000; // ~1.7 h at one packet a second

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function loadRaw<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or storage full: the app still works, it just won't remember */
  }
}

// The session (packets and events) survives a refresh, a sleeping laptop or a browser update.
interface SavedSession {
  v: 1;
  samples: Sample[];
  events: FlightEvent[];
  padAltM: number | null;
}
const savedSession = loadRaw<SavedSession>("tracker.session");
const restoredSamples = savedSession?.v === 1 && Array.isArray(savedSession.samples) ? savedSession.samples.map((s) => ({ ...s, cfg: s.cfg ?? null })) : [];

let state: AppState = {
  conn: "idle",
  connError: null,
  device: "unknown",
  radio: "unknown",
  radioMsg: null,
  flightInfo: null,
  groundInfo: null,
  groundGps: null,
  stats: [],
  command: null,
  lines: [],
  samples: restoredSamples,
  events: savedSession?.events ?? [],
  operator: null,
  deviceLoc: null,
  padAltM: savedSession?.padAltM ?? null,
  lastFix: loadRaw<Sample>("tracker.lastFix"),
  groundSavedFix: null,
  settings: load("tracker.settings", DEFAULT_SETTINGS),
};

const listeners = new Set<() => void>();
export function getState() {
  return state;
}
export function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch };
  save("tracker.settings", settings);
  setState({ settings });
}

let persistTimer: number | null = null;
function persistSoon() {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const s: SavedSession = { v: 1, samples: state.samples.slice(-PERSIST_SAMPLES), events: state.events.slice(-100), padAltM: state.padAltM };
    save("tracker.session", s);
  }, 3000);
}

/** The ground station's own positions this session (for the range test). Memory only. */
export const operatorTrack: { t: number; lat: number; lon: number }[] = [];

let lineId = 0;
function pushLine(text: string, kind: LineKind, t: number): TermLine[] {
  const lines = state.lines.length >= MAX_LINES ? state.lines.slice(-MAX_LINES + 500) : state.lines.slice();
  lines.push({ id: ++lineId, t, text, kind });
  return lines;
}

/** Messages from the app itself (connect, disconnect, commands) shown in the terminal. */
export function logApp(text: string, kind: LineKind = "app") {
  setState({ lines: pushLine(text, kind, Date.now()) });
}

let eventId = state.events.reduce((m, e) => Math.max(m, e.id), 0);
export function addEvent(kind: FlightEvent["kind"], text: string, t = Date.now()) {
  const events = [...state.events.slice(-199), { id: ++eventId, t, kind, text }];
  setState({ events });
  persistSoon();
}

const fmtFt = (m: number) => (state.settings.units === "ft" ? `${Math.round(m * M_TO_FT)} ft` : `${Math.round(m)} m`);

/** Liftoff, apogee, landing and low battery, spotted as packets come in. */
function detectEvents(prev: Sample | undefined, s: Sample) {
  const flying = (x?: Sample) => x?.state === "FLIGHT" || x?.state === "LANDED";
  const had = (k: FlightEvent["kind"]) => state.events.some((e) => e.kind === k && (!liftoffAt() || e.t >= liftoffAt()!));
  if (prev && !flying(prev) && flying(s)) addEvent("liftoff", "Liftoff", s.t);
  if (s.state === "FLIGHT" && s.fresh && s.altM !== null && state.padAltM !== null && !had("apogee")) {
    const agl = s.altM - state.padAltM;
    if (s.maxAglM >= 30 && agl < s.maxAglM - 15) addEvent("apogee", `Apogee about ${fmtFt(s.maxAglM)} (GPS)`, s.t);
  }
  if (prev?.state === "FLIGHT" && s.state === "LANDED") addEvent("landed", "Landed", s.t);
  if (s.flags !== null && s.flags & FLAG.LOWBATT && !state.events.some((e) => e.kind === "lowbatt" && s.t - e.t < 10 * 60000))
    addEvent("lowbatt", "Rocket battery low", s.t);
  if (s.cfg?.buzzing && !prev?.cfg?.buzzing) addEvent("buzzing", "Rocket buzzer on", s.t);
}
function liftoffAt(): number | null {
  for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].kind === "liftoff") return state.events[i].t;
  return null;
}

/** Feed one text line from the board into the app. */
export function ingestLine(text: string, t = Date.now()) {
  const p = parseLine(text);
  const patch: Partial<AppState> = {};
  let kind: LineKind = "info";

  if (p.kind === "sample") {
    kind = "packet";
    const s: Sample = { ...p.sample, t };
    const prev = state.samples[state.samples.length - 1];
    const samples = state.samples.length >= MAX_SAMPLES ? state.samples.slice(1) : state.samples.slice();
    samples.push(s);
    patch.samples = samples;
    patch.device = s.src;
    // Pad altitude: the last fresh altitude seen while sitting ready on the pad.
    if (s.state === "PAD-READY" && s.fresh && s.altM !== null) patch.padAltM = s.altM;
    if (s.lat !== null) {
      patch.lastFix = s;
      save("tracker.lastFix", s);
    }
    if (s.src === "flight" && state.radio === "unknown") patch.radio = "ok"; // it printed a packet line after radio init
    setState({ ...patch, lines: pushLine(text, kind, t) });
    detectEvents(prev, s);
    persistSoon();
    return;
  } else if (p.kind === "operator") {
    patch.operator = { t, lat: p.lat, lon: p.lon, altM: p.altM, src: "ground", courseDeg: p.courseDeg, speedMps: p.speedMps, sats: p.sats, hdop: p.hdop };
    operatorTrack.push({ t, lat: p.lat, lon: p.lon });
    if (operatorTrack.length > 20000) operatorTrack.splice(0, 5000);
    patch.groundGps = { t, fix: true, sats: p.sats };
    patch.device = "ground";
  } else if (p.kind === "operator-nofix") {
    patch.groundGps = { t, fix: false, sats: p.sats };
    patch.device = "ground";
  } else if (p.kind === "flight-info") {
    patch.flightInfo = { ...p.info, t };
    patch.device = "flight";
    patch.radio = p.info.radioOk ? "ok" : "failed";
    kind = "ok";
  } else if (p.kind === "ground-info") {
    patch.groundInfo = { ...p.info, t };
    patch.device = "ground";
    kind = "ok";
  } else if (p.kind === "stats") {
    patch.stats = [...state.stats.slice(-1), { ...p.stats, t }];
  } else if (p.kind === "command") {
    kind = "cmd";
    const prev = state.command;
    const sameCmd = prev && prev.cmd === p.status.cmd;
    patch.command = { ...p.status, tries: p.status.tries || (sameCmd ? prev.tries : 0), t };
    if (p.status.phase === "refused" || p.status.phase === "failed") kind = "error";
  } else if (p.kind === "saved-fix") {
    patch.groundSavedFix = { lat: p.lat, lon: p.lon };
    patch.device = "ground";
  } else if (p.kind === "forgot") {
    patch.groundSavedFix = null;
    kind = "ok";
  } else if (p.kind === "status") {
    kind = p.level;
    if (p.device) patch.device = p.device;
    if (p.radio) {
      patch.radio = p.radio;
      patch.radioMsg = p.radio === "failed" ? radioErrorHint(p.text) ?? p.text : null;
    }
  }
  patch.lines = pushLine(text, kind, t);
  setState(patch);
}

/** What the app shows as "waiting" before the board answers a command it sent. */
export function noteCommandSent(cmd: CommandStatus["cmd"], arg: string, via: CommandStatus["via"]) {
  setState({ command: { t: Date.now(), cmd, arg, phase: "waiting", tries: 0, via } });
}

/** Board info and link state forget the board when a new one is plugged in. */
export function resetLinkState() {
  setState({ device: "unknown", radio: "unknown", radioMsg: null, flightInfo: null, groundInfo: null, groundGps: null, stats: [], command: null, operator: null });
}

export function clearSession() {
  setState({ samples: [], lines: [], events: [], padAltM: null });
  try {
    localStorage.removeItem("tracker.session");
  } catch {
    /* ignore */
  }
}

export function forgetLastFix() {
  try {
    localStorage.removeItem("tracker.lastFix");
  } catch {
    /* ignore */
  }
  setState({ lastFix: null });
}

/** The rocket's settings: from its packets while they're arriving, else from its USB info line. */
export function rocketCfg(s: AppState, now: number): { cfg: RocketCfg; from: "packet" | "usb" } | null {
  const latest = s.samples[s.samples.length - 1];
  const fi = s.device === "flight" ? s.flightInfo : null;
  // A settings change over USB prints the info line right away; the next packet follows within a second.
  if (fi && (!latest?.cfg || fi.t >= latest.t))
    return { cfg: { nonComp: fi.nonComp, landBeep: fi.landBeep, buzzing: latest?.cfg?.buzzing ?? false, quiet: fi.quiet }, from: "usb" };
  if (latest?.cfg && now - latest.t < 15000) return { cfg: latest.cfg, from: "packet" };
  if (fi) return { cfg: { nonComp: fi.nonComp, landBeep: fi.landBeep, buzzing: false, quiet: fi.quiet }, from: "usb" };
  if (latest?.cfg) return { cfg: latest.cfg, from: "packet" };
  return null;
}

/** You: the ground station's GPS if it's current, else this device's location. */
export function currentOperator(s: AppState, now: number): Operator | null {
  if (s.operator && now - s.operator.t < 8000) return s.operator;
  if (s.deviceLoc) return s.deviceLoc;
  return s.operator;
}

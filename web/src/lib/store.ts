import { useSyncExternalStore } from "react";
import { parseLine, radioErrorHint } from "./parser";
import type { LineKind, Operator, Sample, Settings, TermLine } from "./types";

export type Conn = "idle" | "connecting" | "usb" | "sim" | "error";

export interface AppState {
  conn: Conn;
  connError: string | null;
  device: "unknown" | "flight" | "ground";
  radio: "unknown" | "ok" | "failed";
  radioMsg: string | null;
  lines: TermLine[];
  samples: Sample[];
  operator: Operator | null;
  padAltM: number | null;
  lastFix: Sample | null; // newest sample with a position; kept across reloads
  settings: Settings;
}

// Default map/simulator site: Great Meadow, The Plains VA (a public launch field, approximate).
// Your own site is stored only in this browser.
export const DEFAULT_SITE = { name: "Great Meadow, VA", lat: 38.885, lon: -77.7745 };

const DEFAULT_SETTINGS: Settings = {
  units: "ft",
  layer: "satellite",
  site: DEFAULT_SITE,
  simSpeed: 1,
  windMps: 5,
  windFromDeg: 250,
};

const MAX_LINES = 3000;
const MAX_SAMPLES = 20000;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or storage full: the app still works, it just won't remember */
  }
}

let state: AppState = {
  conn: "idle",
  connError: null,
  device: "unknown",
  radio: "unknown",
  radioMsg: null,
  lines: [],
  samples: [],
  operator: null,
  padAltM: null,
  lastFix: (() => {
    try {
      const raw = localStorage.getItem("tracker.lastFix");
      return raw ? (JSON.parse(raw) as Sample) : null;
    } catch {
      return null;
    }
  })(),
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

let lineId = 0;
function pushLine(text: string, kind: LineKind, t: number): TermLine[] {
  const lines = state.lines.length >= MAX_LINES ? state.lines.slice(-MAX_LINES + 500) : state.lines.slice();
  lines.push({ id: ++lineId, t, text, kind });
  return lines;
}

/** Messages from the app itself (connect, disconnect, simulator) shown in the terminal. */
export function logApp(text: string) {
  setState({ lines: pushLine(text, "app", Date.now()) });
}

/** Feed one text line from the board (or the simulator) into the app. */
export function ingestLine(text: string, t = Date.now()) {
  const p = parseLine(text);
  const patch: Partial<AppState> = {};
  let kind: LineKind = "info";

  if (p.kind === "sample") {
    kind = "packet";
    const s: Sample = { ...p.sample, t };
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
  } else if (p.kind === "operator") {
    patch.operator = { t, lat: p.lat, lon: p.lon, altM: p.altM, src: "ground" };
    kind = "info";
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

export function clearSession() {
  setState({ samples: [], lines: [], padAltM: null, radio: "unknown", radioMsg: null, device: "unknown" });
}

export function forgetLastFix() {
  try {
    localStorage.removeItem("tracker.lastFix");
  } catch {
    /* ignore */
  }
  setState({ lastFix: null });
}

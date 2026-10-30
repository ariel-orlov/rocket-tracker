import { M_TO_FT } from "../lib/geo";

export function fmtAlt(m: number | null, units: "ft" | "m"): string {
  if (m === null || !Number.isFinite(m)) return "—";
  return units === "ft" ? `${Math.round(m * M_TO_FT)} ft` : `${Math.round(m)} m`;
}

/** Ground distances: ft/m up close, then mi/km. */
export function fmtDist(m: number, units: "ft" | "m"): string {
  if (units === "ft") {
    const ft = m * M_TO_FT;
    return ft < 2000 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(2)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Vertical speed: ft/s or m/s, with a sign. */
export function fmtVs(mps: number | null, units: "ft" | "m"): string {
  if (mps === null || !Number.isFinite(mps)) return "—";
  const v = units === "ft" ? mps * M_TO_FT : mps;
  return `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)} ${units}/s`;
}

/** 75 → "1:15" */
export function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}

export function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "turn right 35°", "straight ahead", "turn around" */
export function turnText(bearing: number, heading: number): string {
  const rel = ((bearing - heading + 540) % 360) - 180;
  const a = Math.abs(Math.round(rel));
  if (a <= 10) return "straight ahead";
  if (a >= 160) return "behind you";
  return `turn ${rel > 0 ? "right" : "left"} ${a}°`;
}

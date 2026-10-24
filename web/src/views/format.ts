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

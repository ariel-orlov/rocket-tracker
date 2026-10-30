import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Quality } from "../lib/signal";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Bearing to the rocket. With a heading (phone compass or walking direction) the dial turns
 * so the top is where you're facing and the arrow is "go this way"; without one, north is up.
 */
export function Compass({ bearing, heading, size = 96 }: { bearing: number | null; heading: number | null; size?: number }) {
  const rose = heading === null ? 0 : -heading;
  const arrow = bearing === null ? null : bearing + rose;
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" role="img"
      aria-label={bearing === null ? "No bearing" : heading === null ? `Bearing ${Math.round(bearing)} degrees` : `Rocket ${Math.round(((bearing - heading + 540) % 360) - 180)} degrees from where you face`}>
      <circle r="46" fill="none" stroke="var(--line)" strokeWidth="2" />
      <g transform={`rotate(${rose})`}>
        {[0, 90, 180, 270].map((a) => (
          <line key={a} x1="0" y1="-46" x2="0" y2="-38" stroke="var(--muted)" strokeWidth="2" transform={`rotate(${a})`} />
        ))}
        <text y="-28" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--muted)" transform={`rotate(${-rose} 0 -32)`}>N</text>
      </g>
      {heading !== null && <path d="M0 -50 L4 -43 L-4 -43 Z" fill="var(--operator)" />}
      {arrow !== null && (
        <g transform={`rotate(${arrow})`}>
          <path d="M0 -34 L9 8 L0 2 L-9 8 Z" fill="var(--accent)" />
          <line x1="0" y1="2" x2="0" y2="24" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

export function SignalBars({ q, size = 22 }: { q: Quality | null; size?: number }) {
  const bars = q?.bars ?? 0;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={q ? `${q.label}, ${bars} of 4 bars` : "No signal"}>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={2 + i * 5.5} y={18 - i * 5} width="4" height={4 + i * 5} rx="1"
          fill={q && i < bars ? `var(--${q.tone})` : "var(--line)"} />
      ))}
    </svg>
  );
}

export function Switch({ checked, onChange, disabled, label, id }: { checked: boolean | null; onChange: (v: boolean) => void; disabled?: boolean; label: string; id: string }) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked ?? false} aria-label={label} className={`switch ${checked === null ? "unknown" : ""}`}
      disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="knob" />
      <span className="switch-text">{checked === null ? "?" : checked ? "On" : "Off"}</span>
    </button>
  );
}

export function Badge({ tone, children, title }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

/** ✓ / ! / ✗ with a word, so pass and fail are never color alone. */
export function Check({ level, children, detail }: { level: "pass" | "warn" | "fail" | "skip"; children: ReactNode; detail?: ReactNode }) {
  const icon = level === "pass" ? "✓" : level === "warn" ? "!" : level === "fail" ? "✗" : "–";
  return (
    <li className={`check ${level}`}>
      <span className="check-icon" aria-hidden="true">{icon}</span>
      <span>
        <span className="sr-only">{level === "pass" ? "OK: " : level === "warn" ? "Warning: " : level === "fail" ? "Not ready: " : "Skipped: "}</span>
        {children}
        {detail && <span className="small muted"> {detail}</span>}
      </span>
    </li>
  );
}

export interface Pt { x: number; y: number; tip: string }

/**
 * One series against time or distance, with an optional reference line, a crosshair and a
 * tooltip on hover. `kind="dots"` draws a scatter (range test), `"line"` a trace.
 */
export function MiniChart({
  points, kind = "line", height = 120, yLabel, xFmt, yFmt, refs = [], xDomain, yDomain, color = "var(--operator)", ariaLabel, area = false,
}: {
  points: Pt[]; kind?: "line" | "dots"; height?: number; yLabel: string; xFmt: (x: number) => string; yFmt: (y: number) => string;
  refs?: { y: number; label: string }[]; xDomain?: [number, number]; yDomain?: [number, number]; color?: string; ariaLabel: string; area?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length < 2) return <p className="muted small">{yLabel}: not enough data yet.</p>;
  if (kind === "line") points = [...points].sort((a, b) => a.x - b.x);
  const P = { l: 40, r: 10, t: 14, b: 22 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const [x0, x1] = xDomain ?? [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = yDomain ?? [Math.min(...ys, ...refs.map((r) => r.y)), Math.max(...ys, ...refs.map((r) => r.y))];
  if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08;
  y0 -= pad; y1 += pad;
  const X = (x: number) => P.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * (w - P.l - P.r);
  const Y = (y: number) => P.t + (1 - (y - y0) / (y1 - y0)) * (height - P.t - P.b);
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bestD = Infinity;
    points.forEach((p, i) => {
      const dd = kind === "line" ? Math.abs(X(p.x) - mx) : Math.hypot(X(p.x) - mx, Y(p.y) - my);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    setHover(bestD < (kind === "line" ? 40 : 24) ? best : null);
  };
  const h = hover !== null ? points[hover] : null;
  const tipLeft = h ? Math.min(Math.max(X(h.x) - 70, 0), w - 150) : 0;

  return (
    <div className="chart" ref={wrap}>
      <svg width={w} height={height} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={w - P.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={P.l - 6} y={Y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">{yFmt(t)}</text>
          </g>
        ))}
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={P.l} x2={w - P.r} y1={Y(r.y)} y2={Y(r.y)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth="1" />
            <text x={w - P.r} y={Y(r.y) - 4} textAnchor="end" fontSize="10" fill="var(--muted)">{r.label}</text>
          </g>
        ))}
        <text x={P.l} y={height - 6} fontSize="10" fill="var(--muted)">{xFmt(x0)}</text>
        <text x={w - P.r} y={height - 6} textAnchor="end" fontSize="10" fill="var(--muted)">{xFmt(x1)}</text>
        {kind === "line" ? (
          <>
            {area && <path d={`${d} L${X(points[points.length - 1].x)},${Y(y0)} L${X(points[0].x)},${Y(y0)} Z`} fill={`color-mix(in srgb, ${color} 16%, transparent)`} />}
            <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
          </>
        ) : (
          points.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="4" fill={color} fillOpacity="0.75" stroke="var(--panel)" strokeWidth="1" />)
        )}
        {h && (
          <g pointerEvents="none">
            {kind === "line" && <line x1={X(h.x)} x2={X(h.x)} y1={P.t} y2={height - P.b} stroke="var(--muted)" strokeWidth="1" />}
            <circle cx={X(h.x)} cy={Y(h.y)} r="5" fill={color} stroke="var(--panel)" strokeWidth="2" />
          </g>
        )}
        <rect x={P.l} y={P.t} width={Math.max(0, w - P.l - P.r)} height={height - P.t - P.b} fill="transparent" />
      </svg>
      {h && <div className="tip" style={{ left: tipLeft }}>{h.tip}</div>}
    </div>
  );
}

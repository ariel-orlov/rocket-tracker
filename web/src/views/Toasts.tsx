import { useEffect, useRef, useState } from "react";
import { useApp } from "../lib/store";
import type { FlightEvent } from "../lib/types";
import { fmtClock } from "./format";

const SHOW_MS = 8000;
const TONE: Record<FlightEvent["kind"], string> = {
  liftoff: "flight", apogee: "info", landed: "landed", lowbatt: "bad", "signal-lost": "bad", "signal-back": "ok", buzzing: "info",
};
const ICON: Record<FlightEvent["kind"], string> = {
  liftoff: "▲", apogee: "◆", landed: "▼", lowbatt: "!", "signal-lost": "✕", "signal-back": "✓", buzzing: "♪",
};

/**
 * New flight events pop up at the top of the screen for 8 s. "Signal lost" stays until the
 * signal is back or you dismiss it. Events restored from a saved session don't pop up.
 */
export function Toasts() {
  const events = useApp((s) => s.events);
  const seen = useRef(events.reduce((m, e) => Math.max(m, e.id), 0));
  const [shown, setShown] = useState<FlightEvent[]>([]);

  useEffect(() => {
    const fresh = events.filter((e) => e.id > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(...fresh.map((e) => e.id));
    setShown((cur) => {
      let next = [...cur, ...fresh];
      if (fresh.some((e) => e.kind === "signal-back")) next = next.filter((e) => e.kind !== "signal-lost");
      return next.slice(-4);
    });
  }, [events]);

  useEffect(() => {
    if (!shown.length) return;
    const id = setInterval(() => setShown((cur) => cur.filter((e) => e.kind === "signal-lost" || Date.now() - e.t < SHOW_MS)), 1000);
    return () => clearInterval(id);
  }, [shown.length]);

  if (!shown.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {shown.map((e) => (
        <div key={e.id} className={`toast ${TONE[e.kind]}`}>
          <span className="toast-icon" aria-hidden="true">{ICON[e.kind]}</span>
          <span className="toast-text">{e.text}</span>
          <span className="small muted num">{fmtClock(e.t)}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={() => setShown((cur) => cur.filter((x) => x.id !== e.id))}>×</button>
        </div>
      ))}
    </div>
  );
}

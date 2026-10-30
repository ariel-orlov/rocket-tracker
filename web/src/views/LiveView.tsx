import { useMemo, type ComponentType } from "react";
import { bearingDeg, distanceM } from "../lib/geo";
import { summarize } from "../lib/flight";
import { currentOperator, rocketCfg, useApp } from "../lib/store";
import { useHeading } from "../lib/device";
import { MapPanel } from "./MapPanel";
import { useNow } from "./widgets";
import {
  BuzzerCard, EventsCard, FlightCard, GroundCard, LastFixCard, PreflightCard, RecoveryCard, RocketCard, RocketSettingsCard,
  SessionCard, SignalCard, StatusCard, SummaryCard, type Ctx,
} from "./cards";

type Card = ComponentType<{ c: Ctx }>;

// What matters most comes first: setup on the pad, altitude in the air, the walk after landing.
// Keyed by name so a card keeps its state (compass on, etc.) when the order changes.
const CARDS: Record<string, Card> = {
  status: StatusCard, preflight: PreflightCard, settings: RocketSettingsCard, buzzer: BuzzerCard, signal: SignalCard,
  rocket: RocketCard, ground: GroundCard, recovery: RecoveryCard, lastfix: LastFixCard, events: EventsCard, session: SessionCard,
  flight: FlightCard, summary: SummaryCard,
};
const ORDER: Record<Ctx["phase"], string[]> = {
  none: ["settings", "ground", "lastfix", "session"],
  pad: ["status", "preflight", "settings", "buzzer", "signal", "rocket", "ground", "recovery", "lastfix", "events", "session"],
  flight: ["status", "flight", "signal", "recovery", "events", "rocket", "ground", "lastfix", "session"],
  landed: ["status", "recovery", "buzzer", "summary", "signal", "lastfix", "flight", "events", "rocket", "ground", "session"],
};

export function LiveView() {
  const now = useNow();
  const st = useApp((s) => s);
  const compassHeading = useHeading();
  const latest = st.samples[st.samples.length - 1] ?? null;
  const op = currentOperator(st, now);
  const summary = useMemo(() => summarize(st.samples, st.padAltM), [st.samples, st.padAltM]);

  const lastFix = st.lastFix;
  const rec = op && lastFix?.lat != null && lastFix.lon != null
    ? { d: distanceM(op.lat, op.lon, lastFix.lat, lastFix.lon), b: bearingDeg(op.lat, op.lon, lastFix.lat, lastFix.lon) }
    : null;
  const s = latest ?? lastFix;
  const phase: Ctx["phase"] = !s ? "none" : s.state === "FLIGHT" ? "flight" : s.state === "LANDED" ? "landed" : "pad";
  const walking = op?.courseDeg != null && (op.speedMps ?? 0) >= 0.8;
  const c: Ctx = {
    now, st, latest, lastFix, op, rec, summary, phase,
    cfg: rocketCfg(st, now),
    connected: st.conn === "usb" || st.conn === "ble",
    linkAgeMs: latest ? now - latest.t : null,
    heading: compassHeading ?? (walking ? op!.courseDeg : null),
    headingSrc: compassHeading !== null ? "compass" : walking ? "walking" : null,
    units: st.settings.units,
  };

  // The flight unit reports how many characters it has received from the GPS. If that count
  // stops moving, the GPS isn't connected or powered: no amount of sky will give a fix.
  const gpsSilent = useMemo(() => {
    const recent = st.samples.filter((x) => x.src === "flight" && x.gpsChars !== undefined).slice(-6);
    return recent.length >= 6 && recent[recent.length - 1].gpsChars === recent[0].gpsChars;
  }, [st.samples]);
  const linkLost = c.connected && c.linkAgeMs !== null && c.linkAgeMs > 10000;

  return (
    <div className="live">
      <MapPanel now={now} />
      <aside className="side" aria-label="Rocket status">
        {gpsSilent && (
          <div className="alert" role="alert">
            <strong>The GPS isn't sending any data</strong>
            <span className="small">
              This isn't a sky or signal problem. The board has received nothing from the GPS module for 6 seconds, so it's not
              connected or not powered. Check that the GPS board is seated firmly on its sockets, the right way round, with USB
              unplugged while you move it.
            </span>
          </div>
        )}
        {linkLost && (
          <div className="alert" role="alert">
            <strong>No packets for {Math.round(c.linkAgeMs! / 1000)} s</strong>
            <span className="small">
              {phase === "flight" ? "Normal for a few seconds under boost or behind terrain. " : ""}The map keeps the last fix. Hold the
              ground station up high, antenna vertical, and walk toward the last position.
            </span>
          </div>
        )}
        {phase === "none" && (
          <div className="empty">
            <p><strong>No data yet.</strong></p>
            <p>
              Turn on the ground station and press <strong>USB</strong> or <strong>Bluetooth</strong> up top. To set the rocket's launch
              type and landing beep, plug the flight unit in over USB instead.
            </p>
          </div>
        )}
        {ORDER[phase].map((k) => {
          const CardView = CARDS[k];
          return <CardView key={k} c={c} />;
        })}
      </aside>
    </div>
  );
}

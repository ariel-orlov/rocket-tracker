import { useEffect, useMemo, useState } from "react";
import { bearingDeg, cardinal, distanceM } from "../lib/geo";
import { clearSession, forgetLastFix, setState, useApp } from "../lib/store";
import { exportCsv, exportKml } from "../lib/export";
import type { Sample } from "../lib/types";
import { MapPanel } from "./MapPanel";
import { fmtAgo, fmtAlt, fmtDist } from "./format";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function Compass({ bearing }: { bearing: number | null }) {
  return (
    <svg width="84" height="84" viewBox="-50 -50 100 100" role="img" aria-label={bearing === null ? "No bearing" : `Bearing ${Math.round(bearing)} degrees`}>
      <circle r="46" fill="none" stroke="var(--line)" strokeWidth="2" />
      {[0, 90, 180, 270].map((a) => (
        <line key={a} x1="0" y1="-46" x2="0" y2="-38" stroke="var(--muted)" strokeWidth="2" transform={`rotate(${a})`} />
      ))}
      <text y="-28" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--muted)">N</text>
      {bearing !== null && (
        <g transform={`rotate(${bearing})`}>
          <path d="M0 -34 L9 8 L0 2 L-9 8 Z" fill="var(--accent)" />
          <line x1="0" y1="2" x2="0" y2="24" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

/** Altitude above the pad over the session. */
function AltSpark({ samples, padAltM, units }: { samples: Sample[]; padAltM: number | null; units: "ft" | "m" }) {
  const pts = samples.filter((s) => s.fresh && s.altM !== null);
  if (pts.length < 2) return <p className="muted small">The altitude trace appears once fixes come in.</p>;
  const base = padAltM ?? Math.min(...pts.map((s) => s.altM!));
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vals = pts.map((s) => s.altM! - base);
  const top = Math.max(10, ...vals);
  const W = 320, H = 90, P = 4;
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (v: number) => H - P - (Math.max(0, v) / top) * (H - 2 * P - 12);
  const d = pts.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(vals[i]).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Altitude over time">
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--line)" />
      <path d={`${d} L${x(t1)},${y(0)} L${x(t0)},${y(0)} Z`} fill="color-mix(in srgb, var(--accent) 18%, transparent)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <text x={W - P} y="11" textAnchor="end" fontSize="10" fill="var(--muted)">peak {fmtAlt(top, units)}</text>
    </svg>
  );
}

export function LiveView() {
  const now = useNow();
  const samples = useApp((s) => s.samples);
  const lastFix = useApp((s) => s.lastFix);
  const operator = useApp((s) => s.operator);
  const padAltM = useApp((s) => s.padAltM);
  const conn = useApp((s) => s.conn);
  const units = useApp((s) => s.settings.units);
  const latest = samples[samples.length - 1] ?? null;
  const [geoErr, setGeoErr] = useState<string | null>(null);

  const rec = useMemo(() => {
    if (!operator || lastFix?.lat == null || lastFix.lon == null) return null;
    return {
      d: distanceM(operator.lat, operator.lon, lastFix.lat, lastFix.lon),
      b: bearingDeg(operator.lat, operator.lon, lastFix.lat, lastFix.lon),
    };
  }, [operator, lastFix]);

  const maxAgl = useMemo(() => samples.reduce((m, s) => Math.max(m, s.maxAglM), 0), [samples]);
  const agl = latest?.altM != null && padAltM !== null ? latest.altM - padAltM : null;
  const linkAge = latest ? now - latest.t : null;
  const linkOk = linkAge !== null && linkAge < 5000;
  const fixAge = lastFix ? now - lastFix.t : null;

  const useLaptopLocation = () => {
    setGeoErr(null);
    if (!navigator.geolocation) return setGeoErr("This browser has no location access.");
    navigator.geolocation.getCurrentPosition(
      (p) => setState({ operator: { t: Date.now(), lat: p.coords.latitude, lon: p.coords.longitude, altM: p.coords.altitude, src: "browser" } }),
      (e) => setGeoErr(e.message),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

  return (
    <div className="live">
      <MapPanel />
      <aside className="side" aria-label="Rocket status">
        {!latest && !lastFix && (
          <div className="empty">
            <p><strong>No data yet.</strong></p>
            <p>Plug in the ground station (or the flight unit) and press <strong>Connect USB</strong>, or press <strong>Simulate flight</strong> to watch a full flight.</p>
          </div>
        )}

        {(latest || lastFix) && (
          <div className="card">
            <div className="row">
              <span className={`state big ${(latest ?? lastFix)!.state}`} style={{ fontSize: 22 }}>{(latest ?? lastFix)!.state}</span>
              <span className="pill">
                <span className={`dot ${conn === "idle" ? "" : linkOk ? "ok" : "bad"}`} />
                {latest ? `#${latest.seq} · ${fmtAgo(linkAge!)}` : "saved fix"}
              </span>
            </div>
            {latest?.rssi != null && (
              <div className="small muted num">Signal {latest.rssi} dBm · SNR {latest.snr} dB</div>
            )}
          </div>
        )}

        <div className="card">
          <h2>Walk to the rocket</h2>
          <div className="recovery">
            <Compass bearing={rec?.b ?? null} />
            <div>
              {rec ? (
                <>
                  <div className="big num">{fmtDist(rec.d, units)}</div>
                  <div className="num" style={{ fontWeight: 700, marginTop: 6 }}>
                    {Math.round(rec.b).toString().padStart(3, "0")}° {cardinal(rec.b)}
                  </div>
                  <div className="small muted">from {operator!.src === "ground" ? "the ground station's GPS" : "this laptop's location"}</div>
                </>
              ) : (
                <div className="small muted">
                  {lastFix ? "Needs your position: the ground station sends it once it has GPS." : "Waiting for a rocket position."}
                </div>
              )}
            </div>
          </div>
          {(!operator || operator.src === "browser") && lastFix && (
            <div className="row">
              <button className="btn small" onClick={useLaptopLocation}>Use this laptop's location</button>
              {geoErr && <span className="small" style={{ color: "var(--bad)" }}>{geoErr}</span>}
            </div>
          )}
        </div>

        {lastFix?.lat != null && (
          <div className="card">
            <h2>Last fix</h2>
            <div className="coords">{lastFix.lat.toFixed(6)}, {lastFix.lon!.toFixed(6)}</div>
            <div className="row">
              <span className="small muted">{fmtAgo(fixAge!)}{latest && lastFix.t !== latest.t ? " · newer packets have no position" : ""}</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button className="btn small" onClick={() => copy(`${lastFix.lat},${lastFix.lon}`)}>Copy</button>
                <a className="btn small" href={`https://maps.google.com/?q=${lastFix.lat},${lastFix.lon}`} target="_blank" rel="noreferrer">Google Maps</a>
              </span>
            </div>
          </div>
        )}

        {latest && (
          <div className="card">
            <h2>Flight</h2>
            <dl className="kv" style={{ margin: 0 }}>
              <div><dt>Altitude (above pad)</dt><dd>{fmtAlt(agl, units)}</dd></div>
              <div><dt>Max (GPS, unofficial)</dt><dd>{fmtAlt(maxAgl, units)}</dd></div>
              <div><dt>Satellites</dt><dd>{latest.sats}{latest.fresh ? "" : " · stale"}</dd></div>
              <div><dt>Battery</dt><dd>{latest.battMv !== null ? `${(latest.battMv / 1000).toFixed(2)} V` : "not wired"}</dd></div>
              {latest.gpsChars !== undefined && (
                <div><dt>GPS data</dt><dd>{latest.gpsChars.toLocaleString()} chars · {latest.badChecksums} bad</dd></div>
              )}
              <div><dt>Packets</dt><dd>{samples.length}</dd></div>
            </dl>
            <AltSpark samples={samples} padAltM={padAltM} units={units} />
          </div>
        )}

        <div className="card">
          <h2>Session</h2>
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button className="btn small" disabled={!samples.length} onClick={() => exportCsv(samples)}>Download CSV</button>
            <button className="btn small" disabled={!samples.length} onClick={() => exportKml(samples)}>Google Earth (KML)</button>
            <button className="btn small" disabled={!samples.length} onClick={clearSession}>Clear</button>
            {lastFix && !latest && <button className="btn small danger" onClick={forgetLastFix}>Forget saved fix</button>}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            The last fix is saved in this browser, so it survives a refresh or a dead laptop battery.
          </p>
        </div>
      </aside>
    </div>
  );
}

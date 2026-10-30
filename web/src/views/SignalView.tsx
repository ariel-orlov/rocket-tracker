import { useMemo, useState } from "react";
import { distanceM } from "../lib/geo";
import { linkMarginDb, packetLoss, quality, radioSamples, SENSITIVITY_DBM, SNR_LIMIT_DB } from "../lib/signal";
import { operatorTrack, useApp } from "../lib/store";
import { download } from "../lib/export";
import type { Sample } from "../lib/types";
import { MiniChart, SignalBars, useNow } from "./widgets";
import { fmtClock, fmtDist, fmtDuration } from "./format";

const WINDOWS = [
  { ms: 2 * 60000, label: "2 min" },
  { ms: 10 * 60000, label: "10 min" },
  { ms: 60 * 60000, label: "1 h" },
];

interface RangePt { t: number; d: number; m: number; rssi: number; snr: number }

/**
 * Pairs each packet with the distance between the ground station and the rocket at that
 * moment (both GPS). Walk away from the rocket lying in grass and this is your range test.
 */
function rangePoints(samples: Sample[], meLines: { t: number; lat: number; lon: number }[]): RangePt[] {
  const out: RangePt[] = [];
  let j = 0;
  for (const s of samples) {
    if (s.src !== "ground" || s.rssi === null || s.snr === null || s.lat === null || s.lon === null) continue;
    while (j + 1 < meLines.length && meLines[j + 1].t <= s.t) j++;
    const me = meLines[j];
    if (!me || Math.abs(me.t - s.t) > 5000) continue;
    out.push({ t: s.t, d: distanceM(me.lat, me.lon, s.lat, s.lon), m: linkMarginDb(s.rssi, s.snr), rssi: s.rssi, snr: s.snr });
  }
  return out;
}

function median(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
}

export function SignalView() {
  const now = useNow(2000);
  const samples = useApp((s) => s.samples);
  const stats = useApp((s) => s.stats);
  const units = useApp((s) => s.settings.units);
  const opTrack = useOperatorTrack();
  const [win, setWin] = useState(WINDOWS[1].ms);

  const w = radioSamples(samples, now, win);
  const all = useMemo(() => samples.filter((s) => s.src === "ground" && s.rssi !== null), [samples]);
  const last = w[w.length - 1];
  const loss = packetLoss(w);
  const range = useMemo(() => rangePoints(samples, opTrack), [samples, opTrack]);
  const farthest = range.reduce<RangePt | null>((b, p) => (!b || p.d > b.d ? p : b), null);
  const gaps = useMemo(() => {
    let longest = 0;
    for (let i = 1; i < all.length; i++) longest = Math.max(longest, all[i].t - all[i - 1].t);
    return longest / 1000;
  }, [all]);
  const stat = stats[stats.length - 1];

  const bucket = units === "ft" ? 152.4 : 100; // 500 ft or 100 m
  const buckets = useMemo(() => {
    const map = new Map<number, RangePt[]>();
    for (const p of range) {
      const k = Math.floor(p.d / bucket);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [range, bucket]);

  const exportRange = () => {
    const rows = range.map((p) => [new Date(p.t).toISOString(), p.d.toFixed(1), p.rssi, p.snr, p.m.toFixed(1)].join(","));
    download("rocket-range-test.csv", ["time_iso,distance_m,rssi_dBm,snr_dB,margin_dB", ...rows].join("\n"), "text/csv");
  };

  if (!all.length)
    return (
      <div className="page">
        <h1>Signal</h1>
        <p className="muted">Signal strength comes from the ground station: connect it over USB or Bluetooth. The flight unit on its own doesn't measure it.</p>
      </div>
    );

  return (
    <div className="page">
      <div className="row">
        <h1>Signal</h1>
        <div className="seg" role="group" aria-label="Time window">
          {WINDOWS.map((x) => <button type="button" key={x.ms} aria-pressed={win === x.ms} onClick={() => setWin(x.ms)}>{x.label}</button>)}
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Now</span>
          <span className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
            <SignalBars q={last && now - last.t < 10000 ? quality(linkMarginDb(last.rssi!, last.snr!)) : null} size={28} />
            <span className="tile-value">{last && now - last.t < 10000 ? `${Math.round(linkMarginDb(last.rssi!, last.snr!))} dB` : "—"}</span>
          </span>
          <span className="small muted">{last ? `${last.rssi} dBm · SNR ${last.snr} dB` : "no packets"}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Packets lost</span>
          <span className="tile-value">{loss ? `${loss.lossPct.toFixed(1)}%` : "—"}</span>
          <span className="small muted">{loss ? `${loss.received} of ${loss.expected}, last ${WINDOWS.find((x) => x.ms === win)?.label}` : ""}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Farthest packet</span>
          <span className="tile-value">{farthest ? fmtDist(farthest.d, units) : "—"}</span>
          <span className="small muted">{farthest ? `${Math.round(farthest.m)} dB margin left` : "needs both GPS fixes"}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Longest gap</span>
          <span className="tile-value">{fmtDuration(gaps)}</span>
          <span className="small muted">{stat ? `${stat.crc} corrupted · ${stat.other} other LoRa` : "this session"}</span>
        </div>
      </div>

      <section className="panel">
        <h3>Link margin over time</h3>
        <p className="small muted">dB to spare before packets stop. Under 10 dB, expect drops. Hover for RSSI and SNR.</p>
        <MiniChart
          ariaLabel="Link margin over time"
          yLabel="Margin"
          height={180}
          area
          points={w.map((s) => ({ x: s.t, y: linkMarginDb(s.rssi!, s.snr!), tip: `${fmtClock(s.t)} · #${s.seq} · ${Math.round(linkMarginDb(s.rssi!, s.snr!))} dB · ${s.rssi} dBm · SNR ${s.snr} dB` }))}
          xDomain={[now - win, now]}
          xFmt={(x) => (Math.abs(x - now) < 1000 ? "now" : fmtClock(x))}
          yFmt={(y) => `${Math.round(y)} dB`}
          refs={[{ y: 10, label: "weak" }, { y: 0, label: "drops" }]}
        />
      </section>

      <section className="panel">
        <div className="row">
          <h3>Range test</h3>
          <button className="btn small" disabled={!range.length} onClick={exportRange}>Download range CSV</button>
        </div>
        <p className="small muted">
          Lay the rocket in the grass, then walk away holding the ground station. Each dot is a packet: distance between the two GPS fixes
          against link margin. Keep going until dots reach the bottom line. You want packets past 500 m.
        </p>
        {range.length >= 2 ? (
          <MiniChart
            kind="dots"
            ariaLabel="Link margin against distance"
            yLabel="Margin"
            height={200}
            color="var(--accent)"
            points={range.map((p) => ({ x: p.d, y: p.m, tip: `${fmtDist(p.d, units)} · ${Math.round(p.m)} dB · ${p.rssi} dBm · SNR ${p.snr} dB` }))}
            xDomain={[0, Math.max(100, ...range.map((p) => p.d))]}
            xFmt={(x) => fmtDist(x, units)}
            yFmt={(y) => `${Math.round(y)} dB`}
            refs={[{ y: 0, label: "drops" }]}
          />
        ) : (
          <p className="small muted">Needs the ground station's GPS and the rocket's GPS at the same time.</p>
        )}
        {buckets.length > 0 && (
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th>Distance</th><th>Packets</th><th>Median margin</th><th>Median RSSI</th><th>Median SNR</th></tr></thead>
              <tbody>
                {buckets.map(([k, pts]) => (
                  <tr key={k}>
                    <td>{fmtDist(k * bucket, units)}–{fmtDist((k + 1) * bucket, units)}</td>
                    <td className="num">{pts.length}</td>
                    <td className="num">{Math.round(median(pts.map((p) => p.m)))} dB</td>
                    <td className="num">{median(pts.map((p) => p.rssi))} dBm</td>
                    <td className="num">{median(pts.map((p) => p.snr)).toFixed(1)} dB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="small muted">
        Margin: above the noise floor it's RSSI minus the receiver's sensitivity (about {SENSITIVITY_DBM} dBm at SF11, 500 kHz); below it,
        SNR minus the decode limit ({SNR_LIMIT_DB} dB). Rough numbers from Semtech's tables; real range depends on terrain and how
        the rocket lies.
      </p>
    </div>
  );
}

function useOperatorTrack() {
  const op = useApp((s) => s.operator); // re-render on each new position
  return useMemo(() => [...operatorTrack], [op]); // eslint-disable-line react-hooks/exhaustive-deps
}

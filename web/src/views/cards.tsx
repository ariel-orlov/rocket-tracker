import { useState } from "react";
import { bearingDeg, cardinal, distanceM } from "../lib/geo";
import { lipoPercent, predictLanding, verticalSpeed, type FlightSummary } from "../lib/flight";
import { linkMarginDb, packetLoss, quality, radioSamples, trend, SNR_LIMIT_DB } from "../lib/signal";
import { beepTest, buzz, cancelCommand, forgetGroundFix, setLandBeep, setMode, setQuiet } from "../lib/link";
import { clearSession, forgetLastFix, updateSettings, type AppState } from "../lib/store";
import { exportCsv, exportGpx, exportKml } from "../lib/export";
import { compassSupported, deviceLocationOn, startCompass, stopCompass, stopDeviceLocation, watchDeviceLocation } from "../lib/device";
import type { CommandStatus, Operator, RocketCfg, Sample } from "../lib/types";
import { Badge, Check, Compass, MiniChart, SignalBars, Switch } from "./widgets";
import { fmtAgo, fmtAlt, fmtClock, fmtDist, fmtDuration, fmtVs, turnText } from "./format";

export interface Ctx {
  now: number;
  st: AppState;
  latest: Sample | null;
  lastFix: Sample | null;
  op: Operator | null;
  rec: { d: number; b: number } | null; // you → rocket
  cfg: { cfg: RocketCfg; from: "packet" | "usb" } | null;
  phase: "none" | "pad" | "flight" | "landed";
  connected: boolean;
  linkAgeMs: number | null;
  heading: number | null;
  headingSrc: "compass" | "walking" | null;
  summary: FlightSummary;
  units: "ft" | "m";
}

const usbFlight = (c: Ctx) => c.st.device === "flight" && c.st.conn === "usb";
const viaGround = (c: Ctx) => c.st.device === "ground" && c.connected;

// ---------------------------------------------------------------- status

export function StatusCard({ c }: { c: Ctx }) {
  const s = c.latest ?? c.lastFix;
  if (!s) return null;
  const linkOk = c.linkAgeMs !== null && c.linkAgeMs < 5000;
  return (
    <div className="card">
      <div className="row">
        <span className={`state big ${s.state}`} style={{ fontSize: 22 }}>{s.state}</span>
        <span className="pill">
          <span className={`dot ${!c.connected ? "" : linkOk ? "ok" : "bad"}`} />
          {c.latest ? `#${c.latest.seq} · ${fmtAgo(c.linkAgeMs!)}` : "saved fix"}
        </span>
      </div>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <ModeBadge c={c} />
        {c.cfg?.cfg.buzzing && <Badge tone="info">Buzzing</Badge>}
        {c.latest?.flags != null && c.latest.flags & 0x20 ? <Badge tone="bad">Low battery</Badge> : null}
      </div>
    </div>
  );
}

export function ModeBadge({ c }: { c: Ctx }) {
  if (!c.cfg) return <Badge tone="muted" title="The rocket runs older firmware, or no packets yet">Mode unknown</Badge>;
  return c.cfg.cfg.nonComp ? (
    <Badge tone="warn" title="Listens for ground commands. Not allowed on competition flights.">Non-competition mode</Badge>
  ) : (
    <Badge tone="ok" title="Transmit-only: never listens to the radio, as competition rules require">Competition mode · transmit-only</Badge>
  );
}

// ---------------------------------------------------------------- pre-flight

export function PreflightCard({ c }: { c: Ctx }) {
  const { st, latest } = c;
  const comp = st.settings.compFlight;
  const live = c.linkAgeMs !== null && c.linkAgeMs < 5000;
  const radio = latest?.rssi != null && latest.snr != null ? linkMarginDb(latest.rssi, latest.snr) : null;
  const cfg = c.cfg?.cfg ?? null;
  const items: { level: "pass" | "warn" | "fail" | "skip"; text: string; detail?: string; required: boolean }[] = [
    { required: true, level: c.connected ? (st.device === "ground" ? "pass" : "warn") : "fail", text: "Ground station connected",
      detail: st.device === "flight" ? "(this is the flight unit on USB; fine for setup, but launch with the ground station)" : undefined },
    { required: true, level: live ? "pass" : "fail", text: "Receiving the rocket", detail: c.latest ? `(last packet ${fmtAgo(c.linkAgeMs!)})` : undefined },
    { required: false, level: radio === null ? "skip" : radio >= 15 ? "pass" : "warn", text: "Strong signal on the pad",
      detail: radio !== null ? `(${Math.round(radio)} dB margin)` : "(needs the ground station)" },
    { required: true, level: latest?.state === "PAD-READY" ? "pass" : latest?.state === "PAD" ? "warn" : "fail", text: "Rocket GPS locked, pad position set",
      detail: latest ? `(${latest.sats} satellites)` : undefined },
    { required: false, level: latest?.battMv == null ? "warn" : latest.battMv >= 3800 ? "pass" : latest.battMv >= 3600 ? "warn" : "fail",
      text: "Rocket battery", detail: latest?.battMv != null ? `(${(latest.battMv / 1000).toFixed(2)} V, ~${lipoPercent(latest.battMv)}%)` : "(not reading)" },
    { required: comp, level: !cfg ? "warn" : cfg.nonComp ? (comp ? "fail" : "pass") : "pass",
      text: comp ? "Competition mode (transmit-only)" : "Mode", detail: !cfg ? "(unknown: older firmware?)" : cfg.nonComp ? "(non-competition: listens for commands)" : "(never listens)" },
    { required: false, level: !cfg ? "warn" : cfg.landBeep ? "pass" : "warn", text: "Beep after landing on",
      detail: cfg && !cfg.landBeep ? "(off: it will land silently)" : undefined },
    { required: false, level: c.op ? "pass" : "warn", text: "Your position known", detail: c.op ? `(${c.op.src === "ground" ? "ground station GPS" : "this device"})` : "(for walk-to distance)" },
  ];
  const blockers = items.filter((i) => i.required && i.level === "fail");
  const warnings = items.filter((i) => i.level === "warn" || (!i.required && i.level === "fail"));
  return (
    <div className="card">
      <div className="row">
        <h2>Pre-flight check</h2>
        <label className="small row" style={{ gap: 6 }}>
          Competition flight
          <Switch id="comp-flight" label="This is a competition flight" checked={comp} onChange={(v) => updateSettings({ compFlight: v })} />
        </label>
      </div>
      <div className={`go ${blockers.length ? "nogo" : warnings.length ? "caution" : "ok"}`} role="status">
        {blockers.length ? "NO-GO" : warnings.length ? "GO, with warnings" : "GO"}
        <span className="small"> {blockers.length ? `${blockers.length} to fix` : warnings.length ? `${warnings.length} to look at` : "everything checks out"}</span>
      </div>
      <ul className="checklist">
        {items.map((i) => <Check key={i.text} level={i.level} detail={i.detail}>{i.text}</Check>)}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- rocket settings

function CommandLine({ cmd, names }: { cmd: CommandStatus | null; names: CommandStatus["cmd"][] }) {
  if (!cmd || !names.includes(cmd.cmd)) return null;
  const age = Date.now() - cmd.t;
  if (cmd.phase === "done" && age > 20000) return null;
  const text = commandText(cmd);
  const tone = cmd.phase === "done" ? "ok" : cmd.phase === "refused" || cmd.phase === "failed" ? "bad" : "muted";
  return <div className={`cmdline ${tone}`} role="status">{text}</div>;
}

export function commandText(cmd: CommandStatus): string {
  const on = ["ON", "1"].includes(cmd.arg.toUpperCase());
  const what =
    cmd.cmd === "BUZZ" ? (cmd.arg === "0" ? "Stop buzzer" : `Buzz ${cmd.arg} s`)
    : cmd.cmd === "LANDBEEP" ? `Beep after landing ${on ? "on" : "off"}`
    : cmd.cmd === "QUIET" ? `Pad chirps ${on ? "muted" : "unmuted"}`
    : cmd.cmd === "MODE" ? (cmd.arg.toUpperCase() === "COMP" ? "Competition mode" : "Non-competition mode")
    : "Beep test";
  const age = Date.now() - cmd.t;
  switch (cmd.phase) {
    case "waiting":
      return age > 5000 ? `${what}: the board didn't answer. It may run firmware without commands; flash the latest.` : `${what}: sending…`;
    case "queued": return `${what}: waiting for the rocket's next packet…`;
    case "sent": return `${what}: sent by radio (try ${cmd.tries} of 6)${cmd.reason ? `, ${cmd.reason}` : ""}. Waiting for the rocket to confirm…`;
    case "done": return cmd.via === "usb" ? `${what}: done.` : `${what}: confirmed by the rocket.`;
    case "refused":
      return cmd.reason === "comp" ? `${what}: refused. The rocket is in competition mode and never listens.`
        : cmd.reason === "oldfw" ? `${what}: refused. The rocket runs older firmware without commands.` : `${what}: refused.`;
    case "failed":
      return cmd.reason === "nolink" ? `${what}: failed. No packets from the rocket for 30 s.` : `${what}: no confirmation after 6 tries. Get closer and try again.`;
    case "cancelled": return `${what}: cancelled.`;
  }
}

export function RocketSettingsCard({ c }: { c: Ctx }) {
  const cfg = c.cfg?.cfg ?? null;
  const usb = usbFlight(c);
  const radioOk = viaGround(c) && !!cfg?.nonComp; // a non-competition rocket can take these by radio
  const canSet = usb || radioOk;
  const pad = c.phase === "pad" || c.phase === "none";
  const why = usb ? null
    : viaGround(c) ? (cfg?.nonComp ? "Sent to the rocket by radio (non-competition mode)." : "In competition mode the rocket can't hear the ground station. Plug the flight unit in over USB to change these.")
    : "Connect the flight unit over USB to change these.";

  const changeMode = (nonComp: boolean) => {
    if (nonComp && c.st.settings.compFlight &&
      !confirm("Non-competition mode makes the rocket listen for commands after each packet. Competition rules ban radio signals to the rocket after liftoff. Switch anyway?")) return;
    void setMode(nonComp);
  };

  return (
    <div className="card">
      <div className="row">
        <h2>Rocket settings</h2>
        {c.cfg && <span className="small muted">{c.cfg.from === "usb" ? "from the board" : "from its packets"}</span>}
      </div>
      <div className="setting">
        <div>
          <strong>Launch type</strong>
          <div className="small muted">
            {cfg?.nonComp ? "Non-competition: listens 400 ms after each packet so you can buzz it." : "Competition: transmit-only, never listens to the radio."}
          </div>
        </div>
        <div className="seg" role="group" aria-label="Launch type">
          <button type="button" aria-pressed={cfg ? !cfg.nonComp : false} disabled={!usb} onClick={() => changeMode(false)}>Competition</button>
          <button type="button" aria-pressed={cfg ? cfg.nonComp : false} disabled={!usb} onClick={() => changeMode(true)}>Non-competition</button>
        </div>
      </div>
      <CommandLine cmd={c.st.command} names={["MODE"]} />
      <div className="setting">
        <div>
          <strong>Beep after landing</strong>
          <div className="small muted">3 long beeps every 2 s once it has landed. Works in competition mode: nothing is sent to the rocket.</div>
        </div>
        <Switch id="landbeep" label="Beep after landing" checked={cfg ? cfg.landBeep : null} disabled={!canSet} onChange={(v) => void setLandBeep(v)} />
      </div>
      <CommandLine cmd={c.st.command} names={["LANDBEEP"]} />
      {pad && (
        <div className="setting">
          <div>
            <strong>Mute pad chirps</strong>
            <div className="small muted">Until launch. Turns itself off at liftoff.</div>
          </div>
          <Switch id="quiet" label="Mute pad chirps" checked={cfg ? cfg.quiet : null} disabled={!canSet} onChange={(v) => void setQuiet(v)} />
        </div>
      )}
      <CommandLine cmd={c.st.command} names={["QUIET"]} />
      {usb && (
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn small" onClick={() => void beepTest()}>Beep test</button>
          <button className="btn small" onClick={() => void buzz(5)}>Buzz 5 s</button>
          <span className="small muted">over USB</span>
        </div>
      )}
      <CommandLine cmd={c.st.command} names={["BEEP"]} />
      {why && <p className="small muted" style={{ margin: 0 }}>{why} Settings are saved on the board, so set them before you close the nose cone.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- buzzer

export function BuzzerCard({ c }: { c: Ctx }) {
  const cfg = c.cfg?.cfg ?? null;
  const usb = usbFlight(c);
  const ground = viaGround(c);
  const pending = c.st.command?.cmd === "BUZZ" && ["waiting", "queued", "sent"].includes(c.st.command.phase);
  return (
    <div className="card">
      <div className="row">
        <h2>Buzzer</h2>
        <ModeBadge c={c} />
      </div>
      {cfg && !cfg.nonComp && (
        <p className="small" style={{ margin: 0 }}>
          Competition launch: the rocket never listens after liftoff, so the button below stays off.{" "}
          {cfg.landBeep ? <>It beeps on its own after landing (<strong>beep after landing: on</strong>). Listen for 3 long beeps.</>
            : <strong className="bad-text">Beep after landing is off, so it will be silent. Turn it on over USB before the next competition flight.</strong>}
        </p>
      )}
      {cfg?.nonComp && <p className="small" style={{ margin: 0 }}>Non-competition launch: the ground station can turn the buzzer on, even after landing.</p>}
      {!cfg && <p className="small muted" style={{ margin: 0 }}>Waiting for a packet that says which mode the rocket is in.</p>}
      <div className="buzz-row">
        <span className="buzz-label">Non-competition launches only</span>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" disabled={!ground || !cfg?.nonComp || pending} onClick={() => void buzz(30)}>Buzz rocket 30 s</button>
          <button className="btn" disabled={!ground || !cfg?.nonComp || pending} onClick={() => void buzz(120)}>2 min</button>
          <button className="btn" disabled={!ground || !cfg?.nonComp} onClick={() => void buzz(0)}>Stop</button>
          {pending && <button className="btn small" onClick={() => void cancelCommand()}>Cancel</button>}
        </div>
      </div>
      {usb && (
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn small" onClick={() => void buzz(5)}>Test buzzer over USB (5 s)</button>
          <button className="btn small" onClick={() => void buzz(0)}>Stop</button>
        </div>
      )}
      <CommandLine cmd={c.st.command} names={["BUZZ"]} />
      {!ground && !usb && <p className="small muted" style={{ margin: 0 }}>Connect the ground station to use the buzzer.</p>}
      {ground && cfg?.nonComp && <p className="small muted" style={{ margin: 0 }}>Also on the ground station: press PRG to buzz 30 s, hold it 1 s to stop.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- signal

export function SignalCard({ c }: { c: Ctx }) {
  const w = radioSamples(c.st.samples, c.now, 120000);
  const last = w[w.length - 1];
  if (c.st.device === "flight" && !w.length)
    return (
      <div className="card">
        <h2>Signal</h2>
        <p className="small muted" style={{ margin: 0 }}>Signal strength comes from the ground station. This is the flight unit on USB.</p>
      </div>
    );
  const stale = !last || c.now - last.t > 10000;
  const m = last ? linkMarginDb(last.rssi!, last.snr!) : null;
  const q = m !== null && !stale ? quality(m) : null;
  const loss = packetLoss(w.filter((s) => c.now - s.t <= 60000));
  const tr = trend(c.st.samples, c.now);
  const [s0, s1] = c.st.stats.length === 2 ? c.st.stats : [null, c.st.stats[0] ?? null];
  return (
    <div className="card">
      <div className="row">
        <h2>Signal</h2>
        <span className="row" style={{ gap: 6 }}>
          <SignalBars q={q} />
          <strong>{q ? q.label : last ? "Lost" : "No packets"}</strong>
        </span>
      </div>
      {last && (
        <dl className="kv" style={{ margin: 0 }}>
          <div><dt>Margin</dt><dd>{Math.round(m!)} dB</dd></div>
          <div><dt>RSSI · SNR</dt><dd>{last.rssi} dBm · {last.snr} dB</dd></div>
          <div><dt>Lost (last min)</dt><dd>{loss ? `${loss.lossPct.toFixed(0)}% · ${loss.received}/${loss.expected}` : "—"}</dd></div>
          <div><dt>Trend (10 s)</dt><dd>{tr ? (tr.dir === "warmer" ? `▲ warmer +${tr.deltaDb.toFixed(0)} dB` : tr.dir === "colder" ? `▼ colder ${tr.deltaDb.toFixed(0)} dB` : "steady") : "—"}</dd></div>
          {s1 && <div><dt>Heard, corrupted</dt><dd>{s1.crc}{s0 && s1.crc > s0.crc ? ` (+${s1.crc - s0.crc})` : ""}</dd></div>}
          {s1 && <div><dt>Other LoRa traffic</dt><dd>{s1.other}</dd></div>}
        </dl>
      )}
      {w.length >= 2 && (
        <MiniChart
          ariaLabel="Link margin over the last 2 minutes"
          yLabel="Margin"
          height={90}
          area
          points={w.map((s) => ({ x: s.t, y: linkMarginDb(s.rssi!, s.snr!), tip: `${fmtClock(s.t)} · ${Math.round(linkMarginDb(s.rssi!, s.snr!))} dB · ${s.rssi} dBm / ${s.snr} dB SNR` }))}
          xDomain={[c.now - 120000, c.now]}
          xFmt={(x) => (x === c.now ? "now" : "−2 min")}
          yFmt={(y) => `${Math.round(y)} dB`}
          refs={[{ y: 0, label: "drops here" }]}
        />
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Margin = dB to spare before packets stop (SF11 decodes down to {SNR_LIMIT_DB} dB SNR). Details in the <a href="#signal">Signal</a> tab.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- recovery

export function RecoveryCard({ c }: { c: Ctx }) {
  const [err, setErr] = useState<string | null>(null);
  const [compass, setCompass] = useState(false);
  const [, force] = useState(0);
  const tr = c.phase === "landed" ? trend(c.st.samples, c.now) : null;
  const toggleCompass = async () => {
    if (compass) { stopCompass(); setCompass(false); return; }
    const e = await startCompass();
    if (e) setErr(e); else setCompass(true);
  };
  const toggleLoc = () => {
    setErr(null);
    if (deviceLocationOn()) stopDeviceLocation();
    else watchDeviceLocation(setErr);
    force((n) => n + 1);
  };
  return (
    <div className="card">
      <h2>Walk to the rocket</h2>
      <div className="recovery">
        <Compass bearing={c.rec?.b ?? null} heading={c.heading} />
        <div>
          {c.rec ? (
            <>
              <div className="big num">{fmtDist(c.rec.d, c.units)}</div>
              <div className="num" style={{ fontWeight: 700, marginTop: 6 }}>
                {Math.round(c.rec.b).toString().padStart(3, "0")}° {cardinal(c.rec.b)}
              </div>
              {c.heading !== null && <div className="turn">{turnText(c.rec.b, c.heading)}</div>}
              <div className="small muted">
                from {c.op!.src === "ground" ? "the ground station's GPS" : "this device's location"}
                {c.headingSrc === "walking" ? " · arrow from your walking direction" : c.headingSrc === "compass" ? " · arrow from the compass" : ""}
              </div>
            </>
          ) : (
            <div className="small muted">
              {c.lastFix ? "Needs your position: the ground station sends it once it has GPS, or use this device's location." : "Waiting for a rocket position."}
            </div>
          )}
        </div>
      </div>
      {tr && (
        <div className={`trend ${tr.dir}`} role="status">
          {tr.dir === "warmer" ? "▲ Warmer: signal up" : tr.dir === "colder" ? "▼ Colder: signal down" : "● Signal steady"} {tr.deltaDb >= 0 ? "+" : ""}{tr.deltaDb.toFixed(0)} dB in 10 s
        </div>
      )}
      {c.lastFix?.fixAgeS !== undefined && c.lastFix.fixAgeS > 10 && (
        <div className="small" style={{ color: "var(--warn)" }}>The rocket's position is {Math.round(c.lastFix.fixAgeS)} s old (it lost GPS). Use warmer/colder and the buzzer.</div>
      )}
      <div className="row" style={{ justifyContent: "flex-start" }}>
        {c.op?.src !== "ground" && (
          <button className="btn small" aria-pressed={deviceLocationOn()} onClick={toggleLoc}>{deviceLocationOn() ? "Stop using this device's GPS" : "Use this device's GPS"}</button>
        )}
        {compassSupported && <button className="btn small" aria-pressed={compass} onClick={() => void toggleCompass()}>{compass ? "Compass on" : "Use phone compass"}</button>}
        {err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- flight

export function FlightCard({ c }: { c: Ctx }) {
  const { latest, st, units } = c;
  if (!latest) return null;
  const pad = st.padAltM;
  const agl = latest.altM != null && pad !== null ? latest.altM - pad : null;
  const vs = verticalSpeed(st.samples);
  const pred = predictLanding(st.samples, pad);
  const predFromYou = pred && c.op ? { d: distanceM(c.op.lat, c.op.lon, pred.lat, pred.lon), b: bearingDeg(c.op.lat, c.op.lon, pred.lat, pred.lon) } : null;
  const sinceLiftoff = c.summary.liftoffT ? (c.now - c.summary.liftoffT) / 1000 : null;
  const fixes = st.samples.filter((s) => s.fresh && s.altM !== null).slice(-600);
  const base = pad ?? (fixes.length ? Math.min(...fixes.map((s) => s.altM!)) : 0);
  return (
    <div className="card">
      <h2>Flight</h2>
      {c.phase === "flight" && (
        <div className="row" style={{ alignItems: "baseline" }}>
          <div className="big num">{fmtAlt(agl, units)}<small>above pad</small></div>
          <div className="num" style={{ fontWeight: 700 }}>{fmtVs(vs, units)}</div>
        </div>
      )}
      <dl className="kv" style={{ margin: 0 }}>
        {c.phase !== "flight" && <div><dt>Altitude (above pad)</dt><dd>{fmtAlt(agl, units)}</dd></div>}
        <div><dt>Max (GPS, unofficial)</dt><dd>{fmtAlt(c.summary.apogeeAglM, units)}</dd></div>
        {c.phase === "flight" && <div><dt>Since liftoff</dt><dd>{fmtDuration(sinceLiftoff)}</dd></div>}
        <div><dt>Satellites</dt><dd>{latest.sats}{latest.fresh ? "" : " · stale"}</dd></div>
        <div><dt>Packets</dt><dd>{st.samples.length}</dd></div>
      </dl>
      {pred && (
        <div className="predict">
          <strong>Predicted landing</strong> in ~{Math.round(pred.inS)} s
          {predFromYou ? <>: {fmtDist(predFromYou.d, units)} {cardinal(predFromYou.b)} of you</> : null}
          <span className="small muted"> (±{fmtDist(pred.spreadM, units)}, the dashed circle on the map)</span>
        </div>
      )}
      {fixes.length >= 2 && (
        <MiniChart
          ariaLabel="Altitude above the pad over time"
          yLabel="Altitude"
          color="var(--accent)"
          area
          points={fixes.map((s) => ({ x: s.t, y: (s.altM! - base) * (units === "ft" ? 3.28084 : 1), tip: `${fmtClock(s.t)} · ${fmtAlt(s.altM! - base, units)} · ${s.state}` }))}
          xFmt={fmtClock}
          yFmt={(y) => `${Math.round(y)} ${units}`}
        />
      )}
    </div>
  );
}

export function SummaryCard({ c }: { c: Ctx }) {
  const f = c.summary;
  if (c.phase !== "landed") return null;
  const fromYou = f.landing && c.op ? distanceM(c.op.lat, c.op.lon, f.landing.lat, f.landing.lon) : null;
  return (
    <div className="card">
      <h2>Flight summary</h2>
      <dl className="kv" style={{ margin: 0 }}>
        <div><dt>Apogee (GPS)</dt><dd>{fmtAlt(f.apogeeAglM, c.units)}</dd></div>
        <div><dt>Flight time</dt><dd>{fmtDuration(f.flightTimeS)}</dd></div>
        <div><dt>Descent rate</dt><dd>{f.descentMps ? fmtVs(-f.descentMps, c.units).replace("-", "") : "—"}</dd></div>
        <div><dt>Drift from pad</dt><dd>{f.driftM !== null ? `${fmtDist(f.driftM, c.units)} ${cardinal(f.driftBearing!)}` : "—"}</dd></div>
        <div><dt>Landed at</dt><dd>{f.landedT ? fmtClock(f.landedT) : "—"}</dd></div>
        <div><dt>From you now</dt><dd>{fromYou !== null ? fmtDist(fromYou, c.units) : "—"}</dd></div>
      </dl>
      <p className="small muted" style={{ margin: 0 }}>GPS estimates. The scoring altimeter is the only official altitude.</p>
    </div>
  );
}

// ---------------------------------------------------------------- hardware

export function RocketCard({ c }: { c: Ctx }) {
  const { latest } = c;
  const fi = c.st.flightInfo;
  if (!latest && !fi) return null;
  const pct = latest?.battMv != null ? lipoPercent(latest.battMv) : null;
  return (
    <div className="card">
      <h2>Rocket</h2>
      <dl className="kv" style={{ margin: 0 }}>
        <div>
          <dt>Battery</dt>
          <dd>{latest?.battMv != null ? `${(latest.battMv / 1000).toFixed(2)} V · ~${pct}%` : "not reading"}</dd>
          {pct !== null && <div className="meter" aria-hidden="true"><div style={{ width: `${pct}%`, background: pct < 25 ? "var(--bad)" : pct < 50 ? "var(--warn)" : "var(--ok)" }} /></div>}
        </div>
        {latest && <div><dt>Satellites</dt><dd>{latest.sats}{latest.fresh ? "" : " · no fresh fix"}</dd></div>}
        {latest?.fixAgeS !== undefined && <div><dt>Position age</dt><dd>{latest.fixAgeS.toFixed(1)} s</dd></div>}
        {latest?.gpsChars !== undefined && <div><dt>GPS data</dt><dd>{latest.gpsChars.toLocaleString()} chars · {latest.badChecksums} bad</dd></div>}
        {fi && <div><dt>Firmware</dt><dd>v{fi.fw} · {fi.powerDbm} dBm{fi.powerDbm < 10 ? " (bench)" : ""}</dd></div>}
        {fi && <div><dt>Team ID</dt><dd>{fi.team}</dd></div>}
      </dl>
    </div>
  );
}

export function GroundCard({ c }: { c: Ctx }) {
  const { st } = c;
  if (st.device !== "ground" && !st.groundInfo) return null;
  const gi = st.groundInfo;
  const gps = st.groundGps;
  const stats = st.stats[st.stats.length - 1];
  const old = !gi && st.samples.some((s) => s.src === "ground" && s.flags === null);
  return (
    <div className="card">
      <h2>Ground station</h2>
      {old && <div className="note" style={{ margin: 0 }}>Older ground station firmware: no Bluetooth, buzzer or link stats. Flash it from the <a href="#flash">Flash</a> tab.</div>}
      <dl className="kv" style={{ margin: 0 }}>
        <div><dt>Link</dt><dd>{st.conn === "ble" ? "Bluetooth" : st.conn === "usb" ? "USB" : "not connected"}</dd></div>
        {gi && <div><dt>Firmware</dt><dd>v{gi.fw} · SF{gi.sf} · {gi.bwKhz} kHz</dd></div>}
        <div><dt>Its GPS</dt><dd>{!gps ? "—" : gps.fix ? `fix · ${gps.sats} sats${st.operator?.hdop !== undefined ? ` · HDOP ${st.operator.hdop}` : ""}` : `searching (${gps.sats} sats)`}</dd></div>
        {stats && <div><dt>Uptime</dt><dd>{fmtDuration(stats.upS)}</dd></div>}
        {stats && <div><dt>Packets heard</dt><dd>{stats.rx.toLocaleString()}</dd></div>}
        {st.groundSavedFix && <div><dt>Saved in its memory</dt><dd className="mono small">{st.groundSavedFix.lat.toFixed(5)}, {st.groundSavedFix.lon.toFixed(5)}</dd></div>}
      </dl>
      {gps && !gps.fix && <p className="small muted" style={{ margin: 0 }}>Its GPS needs open sky for a few minutes after power-on. Until then, the walk-to arrow can use this device's location.</p>}
      {st.groundSavedFix && c.connected && (
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn small danger" onClick={() => confirm("Erase the rocket position saved in the ground station's memory?") && void forgetGroundFix()}>Erase its saved fix</button>
        </div>
      )}
    </div>
  );
}

export function LastFixCard({ c }: { c: Ctx }) {
  const f = c.lastFix;
  if (f?.lat == null) return null;
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);
  return (
    <div className="card">
      <h2>Last fix</h2>
      <div className="coords">{f.lat.toFixed(6)}, {f.lon!.toFixed(6)}</div>
      <div className="row">
        <span className="small muted">{fmtAgo(c.now - f.t)}{c.latest && f.t !== c.latest.t ? " · newer packets have no position" : ""}</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button className="btn small" onClick={() => copy(`${f.lat},${f.lon}`)}>Copy</button>
          <a className="btn small" href={`https://maps.google.com/?q=${f.lat},${f.lon}`} target="_blank" rel="noreferrer">Google Maps</a>
        </span>
      </div>
    </div>
  );
}

export function EventsCard({ c }: { c: Ctx }) {
  const ev = c.st.events.slice(-12).reverse();
  if (!ev.length) return null;
  return (
    <div className="card">
      <h2>Flight log</h2>
      <ol className="events">
        {ev.map((e) => (
          <li key={e.id} className={e.kind}><span className="num muted">{fmtClock(e.t)}</span> {e.text}</li>
        ))}
      </ol>
    </div>
  );
}

export function SessionCard({ c }: { c: Ctx }) {
  const { samples } = c.st;
  return (
    <div className="card">
      <h2>Session</h2>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn small" disabled={!samples.length} onClick={() => exportCsv(samples)}>CSV</button>
        <button className="btn small" disabled={!samples.length} onClick={() => exportKml(samples)}>Google Earth (KML)</button>
        <button className="btn small" disabled={!samples.length} onClick={() => exportGpx(samples)}>GPX</button>
        <button className="btn small" disabled={!samples.length} onClick={() => confirm("Clear this session's packets and flight log?") && clearSession()}>New session</button>
        {c.lastFix && !c.latest && <button className="btn small danger" onClick={forgetLastFix}>Forget saved fix</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Packets and the last fix are saved in this browser, so they survive a refresh or a dead laptop battery.
      </p>
    </div>
  );
}

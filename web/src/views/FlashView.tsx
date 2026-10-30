import { useEffect, useRef, useState } from "react";
import { flashTarget, loadManifest, TARGETS, type FirmwareManifest, type Target } from "../lib/flasher";
import { serialSupported } from "../lib/serial";

export function FlashView() {
  const [manifest, setManifest] = useState<FirmwareManifest | null | undefined>(undefined);
  const [target, setTarget] = useState<Target>(TARGETS[0]);
  const [checks, setChecks] = useState({ antenna: false, board: false, monitor: false });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<"ok" | "fail" | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadManifest().then(setManifest);
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const ready = checks.antenna && checks.board && checks.monitor && !!manifest && serialSupported && !busy;
  const append = (s: string) => setLog((l) => [...l.slice(-400), s.replace(/\r?\n$/, "")]);

  const run = async () => {
    if (!manifest) return;
    setBusy(true);
    setResult(null);
    setProgress(0);
    setLog([]);
    try {
      await flashTarget(target, manifest, append, setProgress);
      setProgress(1);
      setResult("ok");
      append("Done. Go to the Live tab and press Connect USB to see it boot.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/No port selected/i.test(msg)) append("Cancelled: no board was chosen.");
      else {
        append(`Error: ${msg}`);
        setResult("fail");
      }
    } finally {
      setBusy(false);
    }
  };

  const built = manifest?.targets[target.id];

  return (
    <div className="page">
      <h1>Flash firmware</h1>
      <p className="muted">
        Loads the tracker's firmware straight from this page over USB. No Arduino IDE or PlatformIO needed. These builds come from the
        <strong> Code</strong> tab's source, compiled automatically whenever the code changes.
      </p>

      {!serialSupported && <div className="note">Flashing needs Chrome or Edge on a computer.</div>}
      {manifest === null && (
        <div className="note">
          No firmware files in this copy of the app. They're added by the online build. Running it locally? Run
          <code> scripts/build-firmware.sh</code> first.
        </div>
      )}

      <div className="targets" role="radiogroup" aria-label="Which board">
        {TARGETS.map((t) => (
          <label key={t.id} className="target" style={{ position: "relative" }}>
            <input type="radio" name="target" id={`target-${t.id}`} checked={target.id === t.id} onChange={() => setTarget(t)} disabled={busy} />
            <strong>{t.name}</strong>
            <span className="small muted">{t.board}</span>
            <span className="small">{t.note}</span>
            {manifest?.targets[t.id] && (
              <span className="small muted mono">{(manifest.targets[t.id].bytes / 1024).toFixed(0)} KB</span>
            )}
          </label>
        ))}
      </div>

      {target.id === "flight" && (
        <div className="note">Full power (22 dBm, ~160 mW). For the bench, use the bench build.</div>
      )}
      {target.id !== "ground" && (
        <div className="note info">
          The flight unit keeps its settings through a reflash. A board that never had them starts in <strong>competition mode</strong>
          (transmit-only) with <strong>beep after landing on</strong>. Change them on the Live tab with the flight unit plugged in.
        </div>
      )}
      {target.id === "ground" && (
        <div className="note info">
          Flash the ground station and the flight unit from the same version of the app: firmware 3 packets have a settings byte that
          older ground stations reject.
        </div>
      )}

      <div className="checks">
        <h3>Before you flash</h3>
        <label>
          <input type="checkbox" id="chk-antenna" checked={checks.antenna} onChange={(e) => setChecks({ ...checks, antenna: e.target.checked })} />
          <span>The 915 MHz antenna is on the board's <strong>LoRa</strong> socket. The firmware transmits the moment it boots, and transmitting with no antenna can damage the radio.</span>
        </label>
        <label>
          <input type="checkbox" id="chk-board" checked={checks.board} onChange={(e) => setChecks({ ...checks, board: e.target.checked })} />
          <span>The <strong>{target.board}</strong> is plugged in with a USB-C <strong>data</strong> cable.</span>
        </label>
        <label>
          <input type="checkbox" id="chk-monitor" checked={checks.monitor} onChange={(e) => setChecks({ ...checks, monitor: e.target.checked })} />
          <span>Arduino IDE's Serial Monitor is closed (only one program can use the port).</span>
        </label>
      </div>

      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn primary" disabled={!ready} onClick={() => void run()}>
          {busy ? "Flashing…" : `Flash ${target.name}`}
        </button>
        {built && manifest && (
          <span className="small muted">
            Build {manifest.commit.slice(0, 7)} · {new Date(manifest.builtAt).toLocaleString()}
          </span>
        )}
      </div>

      {(busy || progress > 0) && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {result === "fail" && (
        <div className="note">
          Flashing didn't finish. Unplug the board, <strong>hold the B (BOOT) button</strong>, plug it back in, let go, and press Flash again.
          That forces the chip into download mode.
        </div>
      )}
      {log.length > 0 && <div className="logbox" ref={logRef}>{log.join("\n")}</div>}

      <div className="note info">
        When Chrome asks which port to use, pick the one that appeared when you plugged the board in (on a Mac it's named
        <code> usbmodem…</code>). After flashing, the board restarts by itself.
      </div>
    </div>
  );
}

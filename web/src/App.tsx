import { useEffect, useRef, useState } from "react";
import { connectSerial, disconnectSerial, resetBoard, serialSupported } from "./lib/serial";
import { startSim, stopSim } from "./lib/sim";
import { useApp } from "./lib/store";
import { LiveView } from "./views/LiveView";
import { TerminalView } from "./views/TerminalView";
import { FlashView } from "./views/FlashView";
import { CodeView } from "./views/CodeView";
import { SettingsDialog } from "./views/SettingsDialog";

const TABS = [
  { id: "live", label: "Live" },
  { id: "terminal", label: "Terminal" },
  { id: "flash", label: "Flash" },
  { id: "code", label: "Code" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId {
  const h = location.hash.replace("#", "");
  return (TABS.find((t) => t.id === h)?.id ?? "live") as TabId;
}

export function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const conn = useApp((s) => s.conn);
  const connError = useApp((s) => s.connError);
  const device = useApp((s) => s.device);
  const radio = useApp((s) => s.radio);
  const radioMsg = useApp((s) => s.radioMsg);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const connLabel =
    conn === "usb" ? "USB live" : conn === "sim" ? "Simulator" : conn === "connecting" ? "Connecting…" : conn === "error" ? "Error" : "Not connected";
  const connDot = conn === "usb" || conn === "sim" ? "live" : conn === "connecting" ? "warn" : conn === "error" ? "bad" : "";
  const deviceLabel = device === "flight" ? "Flight unit" : device === "ground" ? "Ground station" : null;

  return (
    <div className="app">
      <div>
        <header className="topbar">
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
            Rocket Tracker
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
          <div className="conn">
            <span className="pill" title="Connection">
              <span className={`dot ${connDot}`} />
              {connLabel}
              {deviceLabel && <span className="muted">· {deviceLabel}</span>}
            </span>
            {radio !== "unknown" && (
              <span className="pill" title="Radio self-test from the board's boot message">
                <span className={`dot ${radio === "ok" ? "ok" : "bad"}`} />
                Radio {radio === "ok" ? "OK" : "failed"}
              </span>
            )}
            {conn === "usb" || conn === "connecting" ? (
              <>
                <button className="btn" onClick={() => void resetBoard()} disabled={conn !== "usb"} title="Restart the board to see its boot messages">
                  Reset board
                </button>
                <button className="btn" onClick={() => void disconnectSerial()}>Disconnect</button>
              </>
            ) : conn === "sim" ? (
              <button className="btn" onClick={stopSim}>Stop simulation</button>
            ) : (
              <>
                <button className="btn" onClick={startSim}>Simulate flight</button>
                <button className="btn primary" onClick={() => void connectSerial()} disabled={!serialSupported}>
                  Connect USB
                </button>
              </>
            )}
            <button className="btn icon" aria-label="Settings" title="Settings" onClick={() => settingsRef.current?.showModal()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </div>
        </header>
        {!serialSupported && (
          <div className="banner warn">
            This browser can't talk to USB boards. Open this page in <strong>Chrome</strong> or <strong>Edge</strong> on a computer. The simulator and code still work here.
          </div>
        )}
        {connError && <div className="banner">{connError}</div>}
        {radio === "failed" && <div className="banner">Radio failed to start: {radioMsg}. Don't fly until this says Radio OK.</div>}
      </div>
      <main className="view">
        {/* The map stays mounted so it keeps its view and never tears down mid-animation. */}
        <div hidden={tab !== "live"} style={{ height: "100%" }}>
          <LiveView />
        </div>
        {tab === "terminal" && <TerminalView />}
        {tab === "flash" && <FlashView />}
        {tab === "code" && <CodeView />}
      </main>
      <SettingsDialog ref={settingsRef} />
    </div>
  );
}

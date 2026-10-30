import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { setState, useApp } from "../lib/store";
import { sendLine } from "../lib/link";
import { exportLog } from "../lib/export";
import type { LineKind } from "../lib/types";

const SHOW = 1500; // most recent lines rendered; the full log is in the download

const fmtTime = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0").slice(0, 1)}`;
};

export function TerminalView() {
  const lines = useApp((s) => s.lines);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "status" | LineKind>("all");
  const [follow, setFollow] = useState(true);
  const [cmd, setCmd] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const conn = useApp((s) => s.conn);
  const device = useApp((s) => s.device);
  const connected = conn === "usb" || conn === "ble";
  const quick = device === "flight" ? ["INFO", "BEEP", "BUZZ 5", "BUZZ 0", "MODE COMP", "LANDBEEP ON"] : ["INFO", "BUZZ 30", "BUZZ 0", "CANCEL"];
  const send = (line: string) => {
    if (!line.trim()) return;
    void sendLine(line.trim().toUpperCase());
    setCmd("");
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return lines
      .filter((l) => (kind === "all" ? true : kind === "status" ? l.kind !== "packet" : l.kind === kind))
      .filter((l) => !f || l.text.toLowerCase().includes(f))
      .slice(-SHOW);
  }, [lines, filter, kind]);

  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  // Scrolling up pauses auto-scroll; scrolling back to the bottom resumes it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="term">
      <div className="toolbar">
        <input id="term-filter" type="search" placeholder="Filter lines…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter lines" />
        <select id="term-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Show">
          <option value="all">Everything</option>
          <option value="packet">Packets only</option>
          <option value="status">Messages only</option>
          <option value="error">Errors only</option>
          <option value="cmd">Commands only</option>
        </select>
        <button className="btn small" aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
          {follow ? "Auto-scroll on" : "Auto-scroll paused"}
        </button>
        <span className="muted small num" style={{ marginLeft: "auto" }}>{lines.length.toLocaleString()} lines</span>
        <button className="btn small" disabled={!lines.length} onClick={() => exportLog(lines)}>Download log</button>
        <button className="btn small" disabled={!lines.length} onClick={() => setState({ lines: [] })}>Clear</button>
      </div>
      <div className="screen" ref={box} role="log" aria-live="off">
        {shown.length === 0 ? (
          <div className="ln info"><span className="ts">—</span><span>Raw output from the board shows up here once you connect over USB or connect the ground station.</span></div>
        ) : (
          shown.map((l) => (
            <div key={l.id} className={`ln ${l.kind}`}>
              <span className="ts">{fmtTime(l.t)}</span>
              <span>{l.text}</span>
            </div>
          ))
        )}
      </div>
      <form className="cmdbar" onSubmit={(e) => { e.preventDefault(); send(cmd); }}>
        <input id="term-cmd" className="mono" placeholder={connected ? "Command, e.g. INFO" : "Connect a board to send commands"} value={cmd}
          onChange={(e) => setCmd(e.target.value)} disabled={!connected} aria-label="Command to send" autoComplete="off" />
        <button className="btn small primary" disabled={!connected || !cmd.trim()}>Send</button>
        {quick.map((q) => <button type="button" key={q} className="btn small mono" disabled={!connected} onClick={() => send(q)}>{q}</button>)}
      </form>
    </div>
  );
}

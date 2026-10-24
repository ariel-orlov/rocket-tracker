import { useMemo, useState } from "react";
import flightMain from "../../../firmware/flight-unit/src/main.cpp?raw";
import flightIni from "../../../firmware/flight-unit/platformio.ini?raw";
import groundMain from "../../../firmware/ground-station/src/main.cpp?raw";
import groundIni from "../../../firmware/ground-station/platformio.ini?raw";
import flashSh from "../../../firmware/flash.sh?raw";

const FILES = [
  { group: "Flight unit", path: "firmware/flight-unit/src/main.cpp", text: flightMain, lang: "cpp" },
  { group: "Flight unit", path: "firmware/flight-unit/platformio.ini", text: flightIni, lang: "ini" },
  { group: "Ground station", path: "firmware/ground-station/src/main.cpp", text: groundMain, lang: "cpp" },
  { group: "Ground station", path: "firmware/ground-station/platformio.ini", text: groundIni, lang: "ini" },
  { group: "Tools", path: "firmware/flash.sh", text: flashSh, lang: "sh" },
] as const;

const REPO = "https://github.com/ariel-orlov/rocket-tracker/blob/main/";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Small highlighter: comments, strings, preprocessor lines, numbers, a few keywords.
const KW = /\b(void|bool|int|uint8_t|uint16_t|uint32_t|int16_t|int32_t|float|double|const|char|struct|enum|return|if|else|for|while|true|false|static|size_t|volatile)\b/g;
function highlight(line: string, lang: string): string {
  const commentStart = lang === "cpp" ? line.indexOf("//") : line.search(/(^|\s)[;#]/);
  let code = line, comment = "";
  if (commentStart >= 0 && !(lang === "cpp" && /"[^"]*\/\/[^"]*"/.test(line.slice(0, commentStart + 2)))) {
    code = line.slice(0, commentStart);
    comment = line.slice(commentStart);
  }
  let out = esc(code);
  if (lang === "cpp" && /^\s*#/.test(code)) out = `<span class="tk-p">${out}</span>`;
  else {
    out = out.replace(/(&quot;|")(?:[^"\\]|\\.)*"/g, (m) => `<span class="tk-s">${m}</span>`);
    if (lang === "cpp") out = out.replace(KW, '<span class="tk-k">$1</span>');
    out = out.replace(/(?<![\w#">])(0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)(?![\w<])/g, '<span class="tk-n">$1</span>');
  }
  return out + (comment ? `<span class="tk-c">${esc(comment)}</span>` : "");
}

export function CodeView() {
  const [idx, setIdx] = useState<number | "ref">(0);
  const file = idx === "ref" ? null : FILES[idx];
  const html = useMemo(
    () => (file ? file.text.replace(/\n$/, "").split("\n").map((l) => `<span class="l">${highlight(l, file.lang) || " "}</span>`).join("") : ""),
    [file],
  );
  const copy = () => file && void navigator.clipboard?.writeText(file.text).catch(() => undefined);

  let lastGroup = "";
  return (
    <div className="code">
      <nav className="files" aria-label="Files">
        {FILES.map((f, i) => {
          const showGroup = f.group !== lastGroup;
          lastGroup = f.group;
          return (
            <div key={f.path} style={{ display: "contents" }}>
              {showGroup && <div className="grp">{f.group}</div>}
              <button aria-current={idx === i} onClick={() => setIdx(i)} title={f.path}>
                {f.path.split("/").pop()}
              </button>
            </div>
          );
        })}
        <div className="grp">Reference</div>
        <button aria-current={idx === "ref"} onClick={() => setIdx("ref")}>Packet &amp; radio</button>
      </nav>

      {file ? (
        <div className="source">
          <div className="toolbar" style={{ position: "sticky", top: 0, zIndex: 1 }}>
            <span className="mono small">{file.path}</span>
            <span className="muted small">{file.text.split("\n").length} lines</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="btn small" onClick={copy}>Copy</button>
              <a className="btn small" href={REPO + file.path} target="_blank" rel="noreferrer">GitHub</a>
            </span>
          </div>
          <pre dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      ) : (
        <div className="source ref">
          <div className="page" style={{ margin: 0 }}>
            <h1>Packet and radio reference</h1>
            <p className="muted">Both boards must use identical radio settings or nothing gets through.</p>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Setting</th><th>Value</th><th>Why</th></tr></thead>
                <tbody>
                  <tr><td>Frequency</td><td className="mono">915.0 MHz</td><td>US licence-free band (902–928 MHz)</td></tr>
                  <tr><td>Bandwidth</td><td className="mono">500 kHz</td><td>Wide enough for full power on one channel</td></tr>
                  <tr><td>Spreading factor</td><td className="mono">11</td><td>~165 ms per packet; 12 = more range, twice the airtime</td></tr>
                  <tr><td>Coding rate</td><td className="mono">4/5</td><td>Standard</td></tr>
                  <tr><td>Power</td><td className="mono">22 dBm / 2 dBm</td><td>Flight build / bench build</td></tr>
                  <tr><td>Sync word</td><td className="mono">0x12</td><td>Private network</td></tr>
                  <tr><td>Rate</td><td className="mono">1 / s, 1 per 3 s landed</td><td>Transmit only: the rocket never listens</td></tr>
                </tbody>
              </table>
            </div>
            <h3>22-byte packet (little-endian)</h3>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Bytes</th><th>Field</th><th>Notes</th></tr></thead>
                <tbody>
                  <tr><td className="mono">0</td><td>magic = 0xA7</td><td>Ignores other LoRa traffic</td></tr>
                  <tr><td className="mono">1</td><td>team ID</td><td>Must match on both boards</td></tr>
                  <tr><td className="mono">2–3</td><td>sequence</td><td>Spot dropped packets</td></tr>
                  <tr><td className="mono">4–11</td><td>lat, lon × 10⁷</td><td>~1 cm resolution</td></tr>
                  <tr><td className="mono">12–13</td><td>altitude, m above sea level</td><td></td></tr>
                  <tr><td className="mono">14</td><td>satellites</td><td></td></tr>
                  <tr><td className="mono">15</td><td>flags</td><td>01 fix · 02 fresh · 04 pad set · 08 flight · 10 landed · 20 low battery</td></tr>
                  <tr><td className="mono">16–17</td><td>fix age, 0.1 s</td><td></td></tr>
                  <tr><td className="mono">18–19</td><td>battery, mV</td><td></td></tr>
                  <tr><td className="mono">20–21</td><td>max height above pad, m</td><td>GPS estimate. The scoring altimeter is the only official altitude.</td></tr>
                </tbody>
              </table>
            </div>
            <h3>What the boards print over USB</h3>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Board</th><th>Line</th></tr></thead>
                <tbody>
                  <tr><td>Flight unit</td><td className="mono small">#12 st=0 fix=1 sats=9 LAT,LON alt=120 agl_max=0 batt=4100 gps_chars=1035 bad=0 flags=07</td></tr>
                  <tr><td>Ground station</td><td className="mono small">seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,maps</td></tr>
                  <tr><td>Ground station</td><td className="mono small">ME,LAT,LON,alt_m,sats (its own position, every 2 s)</td></tr>
                  <tr><td>Both</td><td className="mono small">radio OK · radio.begin failed: -2</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

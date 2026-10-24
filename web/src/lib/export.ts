import type { Sample, TermLine } from "./types";

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

export function exportCsv(samples: Sample[]) {
  const head = "time_iso,source,seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr";
  const rows = samples.map((s) =>
    [new Date(s.t).toISOString(), s.src, s.seq, s.state, s.lat ?? "", s.lon ?? "", s.altM ?? "", s.sats, s.fresh ? 1 : 0,
      s.battMv ?? "", s.maxAglM, s.rssi ?? "", s.snr ?? ""].join(","),
  );
  download(`rocket-flight-${stamp()}.csv`, [head, ...rows].join("\n"), "text/csv");
}

/** Google Earth track: open the file and the flight path shows in 3D. */
export function exportKml(samples: Sample[]) {
  const pts = samples.filter((s) => s.lat !== null && s.lon !== null && s.fresh);
  const coords = pts.map((s) => `${s.lon},${s.lat},${s.altM ?? 0}`).join(" ");
  const last = pts[pts.length - 1];
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Rocket flight ${stamp()}</name>
<Style id="t"><LineStyle><color>ff1f6bf0</color><width>3</width></LineStyle></Style>
<Placemark><name>Flight path</name><styleUrl>#t</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>
${last ? `<Placemark><name>Last fix</name><Point><coordinates>${last.lon},${last.lat},0</coordinates></Point></Placemark>` : ""}
</Document></kml>`;
  download(`rocket-flight-${stamp()}.kml`, kml, "application/vnd.google-earth.kml+xml");
}

export function exportLog(lines: TermLine[]) {
  const text = lines.map((l) => `${new Date(l.t).toISOString()}  ${l.text}`).join("\n");
  download(`rocket-terminal-${stamp()}.log`, text, "text/plain");
}

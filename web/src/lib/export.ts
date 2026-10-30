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
const bit = (b: boolean | undefined) => (b === undefined ? "" : b ? 1 : 0);

export function exportCsv(samples: Sample[]) {
  const head = "time_iso,source,seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,flags,non_comp,land_beep,buzzing";
  const rows = samples.map((s) =>
    [new Date(s.t).toISOString(), s.src, s.seq, s.state, s.lat ?? "", s.lon ?? "", s.altM ?? "", s.sats, s.fresh ? 1 : 0,
      s.battMv ?? "", s.maxAglM, s.rssi ?? "", s.snr ?? "", s.flags ?? "", bit(s.cfg?.nonComp), bit(s.cfg?.landBeep), bit(s.cfg?.buzzing)].join(","),
  );
  download(`rocket-flight-${stamp()}.csv`, [head, ...rows].join("\n"), "text/csv");
}

const track = (samples: Sample[]) => samples.filter((s) => s.lat !== null && s.lon !== null && s.fresh);

/** Google Earth track: open the file and the flight path shows in 3D. */
export function exportKml(samples: Sample[]) {
  const pts = track(samples);
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

/** GPX for phone map apps (Gaia, OsmAnd, Google My Maps): the track plus a "Rocket" waypoint. */
export function exportGpx(samples: Sample[]) {
  const pts = track(samples);
  const last = pts[pts.length - 1];
  const trkpts = pts.map((s) => `<trkpt lat="${s.lat}" lon="${s.lon}"><ele>${s.altM ?? 0}</ele><time>${new Date(s.t).toISOString()}</time></trkpt>`).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rocket Tracker" xmlns="http://www.topografix.com/GPX/1/1">
${last ? `<wpt lat="${last.lat}" lon="${last.lon}"><name>Rocket</name></wpt>` : ""}
<trk><name>Rocket flight ${stamp()}</name><trkseg>
${trkpts}
</trkseg></trk></gpx>`;
  download(`rocket-flight-${stamp()}.gpx`, gpx, "application/gpx+xml");
}

export function exportLog(lines: TermLine[]) {
  const text = lines.map((l) => `${new Date(l.t).toISOString()}  ${l.text}`).join("\n");
  download(`rocket-terminal-${stamp()}.log`, text, "text/plain");
}

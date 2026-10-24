import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { distanceM } from "../lib/geo";
import { useApp } from "../lib/store";
import { fmtDist } from "./format";

const LAYERS = {
  street: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    opts: { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" },
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    opts: { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
  },
};

const icon = (cls: string, size: number) =>
  L.divIcon({ className: "", html: `<div class="mk ${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

export function MapPanel() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const parts = useRef<{
    track: L.Polyline;
    rocket: L.Marker;
    op: L.Marker;
    pad: L.Marker;
    link: L.Polyline;
  } | null>(null);
  const [follow, setFollow] = useState(true);

  const samples = useApp((s) => s.samples);
  const lastFix = useApp((s) => s.lastFix);
  const operator = useApp((s) => s.operator);
  const layer = useApp((s) => s.settings.layer);
  const site = useApp((s) => s.settings.site);
  const units = useApp((s) => s.settings.units);

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([site.lat, site.lon], 17);
    map.current = m;
    parts.current = {
      link: L.polyline([], { color: "#5aa2ff", weight: 2, dashArray: "6 6", opacity: 0.85 }).addTo(m),
      track: L.polyline([], { color: "#f2733a", weight: 4, opacity: 0.95 }).addTo(m),
      rocket: L.marker([0, 0], { icon: icon("mk-rocket", 18), zIndexOffset: 1000, title: "Rocket" }),
      op: L.marker([0, 0], { icon: icon("mk-op", 14), title: "You (ground station)" }),
      pad: L.marker([0, 0], { icon: icon("mk-pad", 12), title: "Pad" }),
    };
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.stop(); // cancel pan/zoom animations so their timers don't fire on a removed map
      m.off();
      m.remove();
      map.current = null;
      parts.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Base layer.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    tiles.current?.remove();
    const def = LAYERS[layer];
    tiles.current = L.tileLayer(def.url, def.opts).addTo(m);
  }, [layer]);

  // Recentre when the launch site setting changes and there's no data yet.
  useEffect(() => {
    if (map.current && !lastFix) map.current.setView([site.lat, site.lon], 17, { animate: false });
  }, [site.lat, site.lon, lastFix]);

  // Draw data.
  useEffect(() => {
    const m = map.current;
    const p = parts.current;
    if (!m || !p) return;
    const pts = samples.filter((s) => s.lat !== null && s.fresh).map((s) => [s.lat!, s.lon!] as [number, number]);
    p.track.setLatLngs(pts);

    const padSample = [...samples].reverse().find((s) => s.state === "PAD-READY" && s.lat !== null && s.fresh);
    if (padSample) p.pad.setLatLng([padSample.lat!, padSample.lon!]).addTo(m);
    else p.pad.remove();

    if (operator) {
      p.op.setLatLng([operator.lat, operator.lon]).addTo(m);
      if (lastFix?.lat != null && lastFix.lon != null) p.link.setLatLngs([[operator.lat, operator.lon], [lastFix.lat, lastFix.lon]]);
    } else {
      p.op.remove();
      p.link.setLatLngs([]);
    }
    p.track.bringToFront(); // the flight path wins over the dashed "walk here" line

    if (lastFix?.lat != null && lastFix.lon != null) {
      p.rocket.setLatLng([lastFix.lat, lastFix.lon]).addTo(m);
      const dist = operator ? ` · ${fmtDist(distanceM(operator.lat, operator.lon, lastFix.lat, lastFix.lon), units)}` : "";
      const label = `${lastFix.state}${dist}`;
      if (p.rocket.getTooltip()) p.rocket.setTooltipContent(label);
      else p.rocket.bindTooltip(label, { permanent: true, className: "dist-label", direction: "right", offset: [12, 0] });
      if (follow) m.panTo([lastFix.lat, lastFix.lon], { animate: true });
    } else p.rocket.remove();
  }, [samples, lastFix, operator, follow, units]);

  const fitAll = () => {
    const m = map.current;
    if (!m) return;
    const pts: [number, number][] = samples.filter((s) => s.lat !== null).map((s) => [s.lat!, s.lon!]);
    if (lastFix?.lat != null && lastFix.lon != null) pts.push([lastFix.lat, lastFix.lon]);
    if (operator) pts.push([operator.lat, operator.lon]);
    if (pts.length) m.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 18 });
    setFollow(false);
  };

  return (
    <div className="mapwrap">
      <div ref={el} className="map" role="region" aria-label="Map of rocket position" />
      <div className="map-tools">
        <button className="btn small" aria-pressed={follow} onClick={() => setFollow((f) => !f)} title="Keep the rocket centred">
          Follow
        </button>
        <button className="btn small" onClick={fitAll} title="Zoom to show rocket, track and you">
          Fit all
        </button>
      </div>
    </div>
  );
}

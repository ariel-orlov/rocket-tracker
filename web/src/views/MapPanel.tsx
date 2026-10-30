import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { distanceM } from "../lib/geo";
import { predictLanding, summarize } from "../lib/flight";
import { currentOperator, useApp } from "../lib/store";
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

// Rings around the pad: about how far a rocket drifts in light, moderate and strong wind.
const RINGS_M = [100, 250, 500];

export function MapPanel({ now }: { now: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const parts = useRef<{
    track: L.Polyline;
    rocket: L.Marker;
    op: L.Marker;
    pad: L.Marker;
    apogee: L.Marker;
    link: L.Polyline;
    predict: L.Circle;
    rings: L.LayerGroup;
  } | null>(null);
  const [follow, setFollow] = useState(true);

  const st = useApp((s) => s);
  const { samples, lastFix, padAltM } = st;
  const { layer, site, units } = st.settings;
  const operator = currentOperator(st, now);
  const summary = useMemo(() => summarize(samples, padAltM), [samples, padAltM]);
  const pred = useMemo(() => predictLanding(samples, padAltM), [samples, padAltM]);

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([site.lat, site.lon], 17);
    map.current = m;
    parts.current = {
      rings: L.layerGroup().addTo(m),
      link: L.polyline([], { color: "#5aa2ff", weight: 2, dashArray: "6 6", opacity: 0.85 }).addTo(m),
      track: L.polyline([], { color: "#f2733a", weight: 4, opacity: 0.95 }).addTo(m),
      predict: L.circle([0, 0], { radius: 20, color: "#c58cff", weight: 2, dashArray: "5 5", fillOpacity: 0.12 }),
      rocket: L.marker([0, 0], { icon: icon("mk-rocket", 18), zIndexOffset: 1000, title: "Rocket" }),
      op: L.marker([0, 0], { icon: icon("mk-op", 14), title: "You" }),
      pad: L.marker([0, 0], { icon: icon("mk-pad", 12), title: "Pad" }),
      apogee: L.marker([0, 0], { icon: icon("mk-apogee", 10), title: "Apogee (GPS)" }),
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

  // Pad rings, redrawn only when the pad moves.
  const padKey = summary.pad ? `${summary.pad.lat.toFixed(6)},${summary.pad.lon.toFixed(6)}` : "";
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    p.rings.clearLayers();
    if (!summary.pad) return;
    for (const r of RINGS_M) {
      L.circle([summary.pad.lat, summary.pad.lon], { radius: r, color: "#ffffff", weight: 1, opacity: 0.35, fill: false, interactive: false }).addTo(p.rings);
      const labelAt = L.latLng(summary.pad.lat + r / 111320, summary.pad.lon);
      L.marker(labelAt, {
        interactive: false,
        icon: L.divIcon({ className: "ring-label", html: fmtDist(r, units), iconSize: [60, 14], iconAnchor: [30, 7] }),
      }).addTo(p.rings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padKey, units]);

  // Draw data.
  useEffect(() => {
    const m = map.current;
    const p = parts.current;
    if (!m || !p) return;
    const pts = samples.filter((s) => s.lat !== null && s.fresh).map((s) => [s.lat!, s.lon!] as [number, number]);
    p.track.setLatLngs(pts);

    if (summary.pad) p.pad.setLatLng([summary.pad.lat, summary.pad.lon]).addTo(m);
    else p.pad.remove();

    const top = summary.apogeeT ? samples.find((s) => s.t === summary.apogeeT && s.lat !== null) : undefined;
    if (top) p.apogee.setLatLng([top.lat!, top.lon!]).addTo(m);
    else p.apogee.remove();

    if (pred) {
      p.predict.setLatLng([pred.lat, pred.lon]).setRadius(pred.spreadM).addTo(m);
      p.predict.bindTooltip(`Predicted landing, ~${Math.round(pred.inS)} s`, { direction: "top" });
    } else p.predict.remove();

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
    // operator changes every 2 s; compare by value so the effect doesn't fire every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, lastFix, operator?.lat, operator?.lon, follow, units, summary, pred]);

  const fitAll = () => {
    const m = map.current;
    if (!m) return;
    const pts: [number, number][] = samples.filter((s) => s.lat !== null).map((s) => [s.lat!, s.lon!]);
    if (lastFix?.lat != null && lastFix.lon != null) pts.push([lastFix.lat, lastFix.lon]);
    if (operator) pts.push([operator.lat, operator.lon]);
    if (pred) pts.push([pred.lat, pred.lon]);
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
      <div className="map-legend small" aria-hidden="true">
        <span><i className="mk mk-rocket" /> Rocket</span>
        <span><i className="mk mk-op" /> You</span>
        <span><i className="mk mk-pad" /> Pad</span>
        {pred && <span><i className="lg-predict" /> Predicted</span>}
      </div>
    </div>
  );
}

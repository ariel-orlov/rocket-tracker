import { forwardRef, useState } from "react";
import { DEFAULT_SITE, forgetLastFix, updateSettings, useApp } from "../lib/store";

export const SettingsDialog = forwardRef<HTMLDialogElement>(function SettingsDialog(_props, ref) {
  const s = useApp((st) => st.settings);
  const [geoErr, setGeoErr] = useState<string | null>(null);

  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);

  const useHere = () => {
    setGeoErr(null);
    navigator.geolocation?.getCurrentPosition(
      (p) => updateSettings({ site: { name: "My launch site", lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5) } }),
      (e) => setGeoErr(e.message),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  return (
    <dialog ref={ref} aria-labelledby="settings-title">
      <form method="dialog" className="dlg">
        <h2 id="settings-title">Settings</h2>

        <div className="grid2">
          <div className="field">
            <span>Altitude units</span>
            <div className="seg">
              {(["ft", "m"] as const).map((u) => (
                <button type="button" key={u} aria-pressed={s.units === u} onClick={() => updateSettings({ units: u })}>{u}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Map</span>
            <div className="seg">
              {(["satellite", "street"] as const).map((l) => (
                <button type="button" key={l} aria-pressed={s.layer === l} onClick={() => updateSettings({ layer: l })}>{l}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="field">
          <span>Launch site (map start point and simulator location)</span>
          <input id="site-name" value={s.site.name} onChange={(e) => updateSettings({ site: { ...s.site, name: e.target.value } })} />
        </div>
        <div className="grid2">
          <label className="field"><span>Latitude</span>
            <input id="site-lat" inputMode="decimal" defaultValue={s.site.lat} key={`lat${s.site.lat}`} onBlur={(e) => updateSettings({ site: { ...s.site, lat: num(e.target.value, s.site.lat) } })} />
          </label>
          <label className="field"><span>Longitude</span>
            <input id="site-lon" inputMode="decimal" defaultValue={s.site.lon} key={`lon${s.site.lon}`} onBlur={(e) => updateSettings({ site: { ...s.site, lon: num(e.target.value, s.site.lon) } })} />
          </label>
        </div>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn small" onClick={useHere}>Use my current location</button>
          <button type="button" className="btn small" onClick={() => updateSettings({ site: DEFAULT_SITE })}>Reset to default site</button>
          {geoErr && <span className="small" style={{ color: "var(--bad)" }}>{geoErr}</span>}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Your site and the last rocket fix are stored only in this browser. Nothing is sent anywhere. To have the map with no signal at the
          field, open the Live tab over the launch site at home and zoom around: tiles you've seen are kept offline.
        </p>

        <h2 style={{ fontSize: 14 }}>Simulator</h2>
        <div className="grid2">
          <label className="field"><span>Speed</span>
            <select id="sim-speed" value={s.simSpeed} onChange={(e) => updateSettings({ simSpeed: Number(e.target.value) })}>
              {[1, 2, 5, 10].map((v) => <option key={v} value={v}>{v}× real time</option>)}
            </select>
          </label>
          <label className="field"><span>Wind (m/s)</span>
            <input id="sim-wind" type="number" min={0} max={15} step={1} value={s.windMps} onChange={(e) => updateSettings({ windMps: num(e.target.value, s.windMps) })} />
          </label>
        </div>
        <label className="field"><span>Wind from (° compass, 270 = from the west)</span>
          <input id="sim-wind-dir" type="number" min={0} max={359} step={10} value={s.windFromDeg} onChange={(e) => updateSettings({ windFromDeg: num(e.target.value, s.windFromDeg) % 360 })} />
        </label>

        <div className="row">
          <button type="button" className="btn small danger" onClick={forgetLastFix}>Forget saved rocket fix</button>
          <button className="btn primary">Done</button>
        </div>
      </form>
    </dialog>
  );
});

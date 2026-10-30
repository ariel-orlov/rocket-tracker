import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { App } from "./App";
import { getState, ingestLine, setState } from "./lib/store";
import { startAlerts } from "./lib/alerts";
import { startWakeLock } from "./lib/device";

// Dev server only: feed raw board lines from the console to test parsing and alerts.
if (import.meta.env.DEV) Object.assign(window, { ingest: ingestLine, store: { getState, setState } });

startAlerts();
startWakeLock();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

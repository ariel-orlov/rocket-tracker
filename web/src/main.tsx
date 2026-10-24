import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { App } from "./App";
import { ingestLine } from "./lib/store";

// Dev server only: feed raw board lines from the console to test parsing and alerts.
if (import.meta.env.DEV) (window as unknown as { ingest: typeof ingestLine }).ingest = ingestLine;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

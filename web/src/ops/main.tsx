import React from "react";
import ReactDOM from "react-dom/client";
import OpsApp from "./OpsApp";
import "../styles.css";

// The ops/governance console (integration-plan group D) is a SEPARATE app from
// the consumer PWA — same chain glue, deliberately no shared nav, no service
// worker. Deployed alongside the PWA at /ops. Today it hosts D1 (the arbiter
// console); D2–D4 (governance / pause / upgrade) will land as sibling tabs.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OpsApp />
  </React.StrictMode>
);

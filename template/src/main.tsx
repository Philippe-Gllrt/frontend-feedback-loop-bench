// Entry point of the trial project: mounts <App /> into #root.
// Intentionally empty of any design: the agent starts from a blank page.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

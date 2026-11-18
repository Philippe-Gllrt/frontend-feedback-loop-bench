// Vite configuration of the empty trial project.
// The port is fixed so that the agent, the skill and the measurement script
// all know where the page is served without having to guess.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// The jailed backend + Oxy build orchestration, mounted in the dev server so
// there's no second process. /codelab/* = tools + preview, /oxy/* = build stream.
import { codeLabPlugin } from "./server/server.mjs";

export default defineConfig({
  plugins: [react(), codeLabPlugin()],
  server: {
    port: 5173,
    // proxy direct Ollama calls (e.g. browser-side model probes) past CORS
    proxy: {
      "/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ollama/, ""),
      },
    },
  },
});

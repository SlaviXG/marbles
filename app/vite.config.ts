import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client talks to the watcher/SSE backend through this proxy, so the
// browser only ever sees same-origin /api requests.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/voice": {
        target: "ws://127.0.0.1:5174",
        ws: true,
      },
      "/api": {
        target: "http://localhost:5174",
        changeOrigin: true,
      },
    },
  },
});

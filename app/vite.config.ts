import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import express from 'express';
import { fileURLToPath } from 'node:url';
import { speechHandler } from './server/transport/speech.mjs';

// The client talks to the watcher/SSE backend through this proxy, so the
// browser only ever sees same-origin /api requests.
export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'marbles-dev-speech',
    configureServer(server) {
      // Keep speech available during development without restarting the task
      // runner. This code and the key stay in Vite's Node process. The regular
      // backend exposes the same handler for production / non-Vite clients.
      const root = fileURLToPath(new URL('..', import.meta.url));
      const apiKey = process.env.OPENAI_API_KEY || loadEnv(mode, root, 'OPENAI_API_KEY').OPENAI_API_KEY;
      const app = express();
      app.post('/', express.json({ limit: '8kb' }), speechHandler({ apiKey }));
      server.middlewares.use('/api/voice/speech', app);
    },
  }],
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
}));

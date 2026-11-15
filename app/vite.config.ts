import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import express from 'express';
import { fileURLToPath } from 'node:url';
import { speechHandler, ttsInfo } from './server/transport/speech.mjs';
import { loadEnv } from './server/env.mjs';

// The client talks to the watcher/SSE backend through this proxy, so the
// browser only ever sees same-origin /api requests.
export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'marbles-dev-speech',
    configureServer(server) {
      if (mode === 'test') return; // Tests must not inherit private runtime settings or keys.
      // Keep speech available during development without restarting the task
      // runner. This code and the key stay in Vite's Node process. The regular
      // backend exposes the same handler for production / non-Vite clients.
      // Keys are read per request from the same env files the backend uses.
      const files = loadEnv();
      console.log(`[marbles] env: ${files.length ? files.join(', ') : 'no .env found (copy .env.example to .env in the repo root)'}`);
      console.log(`[marbles] spoken replies: ${ttsInfo().provider}`);
      const app = express();
      app.post('/', express.json({ limit: '8kb' }), speechHandler());
      server.middlewares.use('/api/voice/speech', app);
    },
  }],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.hermes-runtime/**'] },
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

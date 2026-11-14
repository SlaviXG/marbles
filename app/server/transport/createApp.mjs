import express from "express";
import { detectAgents } from "../agents/detectAgents.mjs";
import { TaskService, resolveArtifact } from "../agents/taskService.mjs";
import { agentLog } from "../agents/logs.mjs";
import { spawn } from "node:child_process";

// Transport layer: exposes the VaultService over HTTP. A snapshot endpoint and
// an SSE stream that subscribes to the service's change events.
export function createApp(service, { agentDetector = detectAgents, taskService = new TaskService({ agentDetector }) } = {}) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/vault", (_req, res) => res.json(service.snapshot()));
  app.get("/api/agents", async (_req, res) => {
    try {
      res.json(await agentDetector());
    } catch (error) {
      console.error("Agent detection failed:", error);
      res.status(500).json({ error: "Agent detection failed" });
    }
  });
  app.get("/api/tasks", (_req, res) => res.json(taskService.snapshot()));
  app.post("/api/agents/:id/tasks", async (req, res) => {
    try { res.status(202).json(await taskService.start(req.params.id, req.body?.prompt)); }
    catch (error) { res.status(error.message === "Agent not found" ? 404 : 400).json({ error: error.message }); }
  });
  app.get("/api/agents/:id/log", async (req, res) => {
    try {
      const agent = (await agentDetector()).find(a => a.instanceName === req.params.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(await agentLog(agent.id));
    } catch { res.status(500).json({ error: "Could not read agent log" }); }
  });
  app.get("/api/artifacts/file", async (req, res) => {
    try {
      const file = await resolveArtifact(taskService.root, req.query.path);
      res.sendFile(file);
    } catch { res.status(400).json({ error: "Invalid artifact path" }); }
  });
  app.post("/api/artifacts/open", async (req, res) => {
    try {
      const file = await resolveArtifact(taskService.root, req.body?.path);
      const child = spawn("open", [file], { shell: false, stdio: "ignore" });
      child.on("error", () => {});
      res.json({ ok: true });
    } catch { res.status(400).json({ error: "Invalid artifact path" }); }
  });

  app.get("/api/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(service.snapshot())}\n\n`);

    const unsubscribe = service.onChange((evt) => {
      const event = evt.type === "update" ? "update" : "remove";
      const data = evt.type === "update" ? evt.note : { id: evt.id };
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    req.on("close", unsubscribe);
  });

  return app;
}

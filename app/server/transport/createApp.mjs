import express from "express";

// Transport layer: exposes the VaultService over HTTP. A snapshot endpoint and
// an SSE stream that subscribes to the service's change events.
export function createApp(service) {
  const app = express();

  app.get("/api/vault", (_req, res) => res.json(service.snapshot()));

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

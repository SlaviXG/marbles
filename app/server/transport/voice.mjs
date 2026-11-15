import { WebSocket, WebSocketServer } from "ws";

// Local desktop prototype: only the regular app/backend and the alternate
// development preview on loopback may spend this key. Keep explicit ports so
// unrelated local sites do not gain access to voice or the protected HTTP APIs.
export function localVoiceOrigin(origin) {
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      ["5173", "5174", "5188"].includes(url.port);
  } catch { return false; }
}

export function bridgeVoice(client, { apiKey, connect = (url, options) => new WebSocket(url, options) }) {
  const send = (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  };
  if (!apiKey) {
    send({ type: "error", message: "Set OPENAI_API_KEY in the repo-root .env and restart the app server." });
    client.close();
    return;
  }
  const upstream = connect("wss://api.openai.com/v1/realtime?intent=transcription", {
    headers: { Authorization: `Bearer ${apiKey}` }, maxPayload: 256 * 1024,
  });
  let ready = false;
  let pending = 0;
  let audioBytes = 0;
  let finishing = false;
  let closed = false;
  const timeout = setTimeout(() => fail("OpenAI connection timed out. Please try again."), 20_000);
  const lifetime = setTimeout(() => fail("Voice session reached its 30 minute limit. Start a new session."), 30 * 60_000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearTimeout(lifetime);
    upstream.close();
  };
  function fail(message) { send({ type: "error", message }); cleanup(); client.close(); }
  function finish() {
    if (finishing && pending === 0) { send({ type: "finished" }); cleanup(); client.close(); }
  }

  upstream.on("open", () => upstream.send(JSON.stringify({
    type: "session.update",
    session: { type: "transcription", audio: { input: {
      format: { type: "audio/pcm", rate: 24000 },
      transcription: { model: "gpt-live-transcribe", languages: ["en"] },
      turn_detection: null,
    } } },
  })));
  upstream.on("message", (data) => {
    if (closed) return;
    let event;
    try { event = JSON.parse(data.toString()); }
    catch { fail("Invalid response from OpenAI. Please reconnect."); return; }
    if (event.type === "session.updated") {
      ready = true;
      clearTimeout(timeout);
      send({ type: "ready" });
    } else if (event.type === "input_audio_buffer.committed") {
      send({ type: "committed", item_id: event.item_id });
    } else if (event.type === "conversation.item.input_audio_transcription.delta") {
      send({ type: "delta", item_id: event.item_id, delta: event.delta });
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      send({ type: "completed", item_id: event.item_id, transcript: event.transcript });
      pending = Math.max(0, pending - 1);
      finish();
    } else if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
      fail("OpenAI transcription failed. Check API access, billing, and the server API key, then try again.");
    }
  });
  upstream.on("unexpected-response", (_request, response) => {
    response.resume();
    fail("OpenAI rejected the connection. Check API access, billing, and the server API key.");
  });
  upstream.on("error", () => fail("Cannot reach OpenAI. Check your connection and API key."));
  upstream.on("close", () => { if (!closed) fail("OpenAI disconnected. Start a new voice session."); });
  client.on("message", (data, binary) => {
    if (closed) return;
    if (!ready || finishing) { fail("Voice session is not ready. Please reconnect."); return; }
    if (upstream.bufferedAmount > 256 * 1024 || client.bufferedAmount > 256 * 1024) {
      fail("Voice connection cannot keep up. Please reconnect."); return;
    }
    if (binary) {
      if (!data.length || data.length % 2 || audioBytes + data.length > 24000 * 2 * 16) {
        fail("Invalid audio turn. Please reconnect."); return;
      }
      audioBytes += data.length;
      upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.toString("base64") }));
      return;
    }
    let event;
    try { event = JSON.parse(data.toString()); }
    catch { fail("Invalid voice message."); return; }
    if (event.type === "commit") {
      if (audioBytes < 4800 || pending >= 6) { fail("Audio was too short or transcription could not keep up. Please try again."); return; }
      audioBytes = 0;
      pending++;
      upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } else if (event.type === "finish") {
      finishing = true;
      finish();
    } else fail("Unsupported voice message.");
  });
  client.on("close", cleanup);
  client.on("error", cleanup);
}

export function attachVoice(server, { apiKey = process.env.OPENAI_API_KEY } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, 15_000);
  heartbeat.unref?.();
  server.on('close', () => clearInterval(heartbeat));
  wss.on('close', () => clearInterval(heartbeat));
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/voice" || !localVoiceOrigin(req.headers.origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    // A closing socket from a reload must not reserve the voice slot. Actual
    // live connections still have one owner; heartbeat reaps abandoned tabs.
    for (const client of wss.clients) if (client.readyState !== WebSocket.OPEN) client.terminate();
    if ([...wss.clients].some(client => client.readyState === WebSocket.OPEN)) {
      socket.end("HTTP/1.1 409 Conflict\r\nX-Marbles-Voice-Error: busy\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      bridgeVoice(client, { apiKey });
    });
  });
  return wss;
}

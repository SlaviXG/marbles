import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeVoice, localVoiceOrigin } from "../transport/voice.mjs";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close = vi.fn();
  message(event) { this.emit("message", Buffer.from(JSON.stringify(event)), false); }
}

describe("voice relay", () => {
  afterEach(() => { vi.useRealTimers(); });
  function setup() {
    vi.useFakeTimers();
    const client = new Socket();
    const upstream = new Socket();
    const connect = vi.fn(() => upstream);
    bridgeVoice(client, { apiKey: "test-secret", connect });
    upstream.emit("open");
    upstream.message({ type: "session.updated" });
    return { client, upstream, connect };
  }
  it("accepts local app origins and rejects remote and malformed origins", () => {
    expect(localVoiceOrigin("http://localhost:5173")).toBe(true);
    expect(localVoiceOrigin("http://127.0.0.1:5174")).toBe(true);
    for (const origin of [undefined, "null", "https://evil.example", "http://localhost.evil.example:5173", "http://localhost:9999"]) {
      expect(localVoiceOrigin(origin)).toBe(false);
    }
  });
  it("reports missing configuration without connecting", () => {
    const client = new Socket();
    const connect = vi.fn();
    bridgeVoice(client, { apiKey: "", connect });
    expect(connect).not.toHaveBeenCalled();
    expect(client.sent[0].message).toContain("OPENAI_API_KEY");
  });
  it("keeps authentication on the upstream and uses a transcription-only session", () => {
    const { client, upstream, connect } = setup();
    expect(connect.mock.calls[0][1].headers.Authorization).toBe("Bearer test-secret");
    expect(upstream.sent[0].session.type).toBe("transcription");
    expect(upstream.sent[0].session.audio.input.transcription.model).toBe("gpt-live-transcribe");
    expect(JSON.stringify(client.sent)).not.toContain("test-secret");
    client.emit("close");
    expect(upstream.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("streams PCM and waits for all final results on stop", () => {
    const { client, upstream } = setup();
    client.emit("message", Buffer.alloc(9600), true);
    client.message({ type: "commit" });
    client.message({ type: "finish" });
    expect(upstream.sent[1].type).toBe("input_audio_buffer.append");
    expect(upstream.sent[2].type).toBe("input_audio_buffer.commit");
    expect(client.sent.some((event) => event.type === "finished")).toBe(false);
    upstream.message({ type: "input_audio_buffer.committed", item_id: "a" });
    upstream.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "hello" });
    upstream.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Hello." });
    expect(client.sent.map((event) => event.type)).toEqual(["ready", "committed", "delta", "completed", "finished"]);
    expect(upstream.close).toHaveBeenCalled();
  });
  it("stops a slow stream instead of buffering indefinitely", () => {
    const { client, upstream } = setup();
    upstream.bufferedAmount = 300_000;
    client.emit("message", Buffer.alloc(9600), true);
    expect(client.sent.at(-1).message).toContain("cannot keep up");
    expect(upstream.close).toHaveBeenCalled();
  });
  it("sanitizes upstream errors and closes both connections", () => {
    const { client, upstream } = setup();
    upstream.message({ type: "error", error: { message: "test-secret" } });
    expect(JSON.stringify(client.sent)).not.toContain("test-secret");
    expect(client.close).toHaveBeenCalled();
    expect(upstream.close).toHaveBeenCalled();
  });
  it("rejects empty commits and malformed messages", () => {
    const { client, upstream } = setup();
    client.message({ type: "commit" });
    expect(client.sent.at(-1).type).toBe("error");
    expect(upstream.close).toHaveBeenCalled();
  });
});

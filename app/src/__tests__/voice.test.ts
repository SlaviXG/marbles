import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioTurns, pcm16, SAMPLE_RATE } from "../voice/audio";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";
import { VoiceSession } from "../voice/VoiceSession";

describe("voice audio", () => {
  it("encodes clipped little endian PCM16", () => {
    const bytes = pcm16(new Float32Array([-2, -0.5, 0, 0.5, 2]));
    const view = new DataView(bytes);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)))
      .toEqual([-32768, -16384, 0, 16384, 32767]);
  });
  it("ignores silence, includes pre-roll, and commits a pause once", () => {
    const turns = new AudioTurns();
    const silence = new Float32Array(SAMPLE_RATE);
    expect(turns.push(silence).audio).toBeUndefined();
    const speech = turns.push(new Float32Array(SAMPLE_RATE).fill(0.1));
    expect(speech.audio!.length).toBe(SAMPLE_RATE * 1.75);
    expect(speech.commit).toBe(false);
    expect(turns.push(silence).commit).toBe(true);
    expect(turns.flush()).toBe(false);
    expect(turns.push(silence).audio).toBeUndefined();
  });
  it("bounds continuous speech and flushes the final unfinished turn", () => {
    const turns = new AudioTurns();
    const speech = new Float32Array(SAMPLE_RATE).fill(0.1);
    turns.push(new Float32Array(SAMPLE_RATE));
    for (let i = 0; i < 14; i++) expect(turns.push(speech).commit).toBe(false);
    expect(turns.push(speech).commit).toBe(true);
    turns.push(speech);
    expect(turns.flush()).toBe(true);
    expect(turns.flush()).toBe(false);
  });
});

describe("transcript ordering", () => {
  it("reconciles deltas and out-of-order completions in speech order", () => {
    let state = emptyTranscript();
    for (const event of [
      { type: "delta", item_id: "a", delta: "hel" },
      { type: "committed", item_id: "a" },
      { type: "committed", item_id: "b" },
      { type: "completed", item_id: "b", transcript: "world" },
      { type: "completed", item_id: "a", transcript: "Hello" },
      { type: "delta", item_id: "a", delta: "stale" },
    ]) state = updateTranscript(state, event);
    expect(transcriptText(state)).toBe("Hello world");
    expect(state.items.a.final).toBe(true);
  });
  it("shows live text before commit without duplicating acknowledgements", () => {
    let state = updateTranscript(emptyTranscript(), { type: "delta", item_id: "a", delta: "Hello" });
    expect(transcriptText(state)).toBe("Hello");
    state = updateTranscript(state, { type: "committed", item_id: "a" });
    state = updateTranscript(state, { type: "committed", item_id: "a" });
    expect(transcriptText(state)).toBe("Hello");
  });
});

describe("microphone lifecycle", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("stops tracks if permission resolves after cancellation", async () => {
    let grant!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("AudioWorkletNode", class {});
    vi.stubGlobal("AudioContext", class {
      state = "running";
      resume = vi.fn().mockResolvedValue(undefined);
      close = close;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } });
    const status = vi.fn();
    const session = new VoiceSession({ status, transcript: vi.fn() });
    const started = session.start();
    await Promise.resolve();
    session.stop();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await started;
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("idle", "Start cancelled.");
  });
  it("reports unsupported browser without opening the microphone", async () => {
    vi.stubGlobal("isSecureContext", false);
    const status = vi.fn();
    await new VoiceSession({ status, transcript: vi.fn() }).start();
    expect(status).toHaveBeenLastCalledWith("error", expect.stringContaining("localhost or HTTPS"));
  });
});

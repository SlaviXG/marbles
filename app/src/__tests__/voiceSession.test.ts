import { afterEach, expect, it, vi } from 'vitest';
import { VoiceSession } from '../voice/VoiceSession';
import { SAMPLE_RATE } from '../voice/audio';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('waits locally for speech, paces startup audio, and drains final words on stop', async () => {
  vi.useFakeTimers();
  const stop = vi.fn();
  const track = { stop, onended: null };
  let capture: any;
  let socket: any;
  const socketCreated = vi.fn();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('location', { href: 'http://localhost:5173/', protocol: 'http:' });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({
    getTracks: () => [track], getAudioTracks: () => [track],
  }) } });
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = SAMPLE_RATE;
    resume = async () => {}; close = async () => {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: undefined, postMessage: vi.fn() };
    connect = vi.fn(); disconnect = vi.fn();
    constructor() { capture = this; }
  });
  vi.stubGlobal('WebSocket', class {
    bufferedAmount = 0; send = vi.fn(); close = vi.fn();
    constructor() { socket = this; socketCreated(); }
  });
  const status = vi.fn();
  const session = new VoiceSession({ status, transcript: vi.fn() });
  await session.start();
  const audio = (value: number) => capture.port.onmessage({ data: new Float32Array(2048).fill(value) });
  for (let i = 0; i < 20; i++) audio(0.002);
  expect(socketCreated).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith('armed', expect.any(String));
  audio(0.1); audio(0.1);
  expect(socketCreated).toHaveBeenCalledOnce();
  expect(socket.send).not.toHaveBeenCalled();
  socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  expect(socket.send).toHaveBeenCalledOnce();
  expect(socket.send.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
  expect(socket.send.mock.calls[0][0].byteLength).toBeLessThanOrEqual(9600);
  expect(status).toHaveBeenLastCalledWith('listening', expect.any(String));
  // Stop with a paced backlog still pending. Its timer must keep draining.
  session.stop();
  capture.port.onmessage({ data: null });
  expect(stop).toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"finish"}');
  const totalBytes = socket.send.mock.calls.reduce((sum: number, [value]: any[]) =>
    sum + (value instanceof ArrayBuffer ? value.byteLength : 0), 0);
  expect(totalBytes).toBeGreaterThan(9600);
  socket.onmessage({ data: JSON.stringify({ type: 'finished' }) });
  expect(socket.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

import { afterEach, expect, it, vi } from 'vitest';
import { VoiceSession } from '../voice/VoiceSession';
import { SAMPLE_RATE } from '../voice/audio';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps standby audio local until a timestamped wake match and suppresses speaker feedback', async () => {
  const workers: any[] = [];
  const sockets: any[] = [];
  let capture: any;
  const track = { stop: vi.fn(), onended: null };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('location', { href: 'http://localhost:5173/', protocol: 'http:' });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = SAMPLE_RATE;
    resume = async () => {}; close = async () => {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: undefined, postMessage: vi.fn() }; connect = vi.fn(); disconnect = vi.fn();
    constructor() { capture = this; }
  });
  vi.stubGlobal('Worker', class {
    postMessage = vi.fn(); terminate = vi.fn(); onmessage: any;
    constructor() { workers.push(this); }
  });
  vi.stubGlobal('WebSocket', class {
    bufferedAmount = 0; send = vi.fn(); close = vi.fn(); onmessage: any;
    constructor() { sockets.push(this); }
  });
  const awake = vi.fn(), wakeDetected = vi.fn();
  const session = new VoiceSession({ status: vi.fn(), transcript: vi.fn(), awake, wakeDetected }, { wake: true });
  const startup = session.start();
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  workers[0].onmessage({ data: { type: 'ready' } });
  await startup;
  const frame = () => capture.port.onmessage({ data: new Float32Array(2048).fill(0.1) });
  for (let i = 0; i < 20; i++) frame();
  expect(sockets).toHaveLength(0);
  const job = workers[0].postMessage.mock.calls.find(([data]: any[]) => data.type === 'audio')[0];
  workers[0].onmessage({ data: { type: 'result', text: 'Marbles', start: 0, epoch: job.epoch, end: job.end, length: job.length } });
  expect(awake).toHaveBeenCalledOnce();
  expect(wakeDetected).toHaveBeenCalledOnce();
  expect(wakeDetected.mock.invocationCallOrder[0]).toBeLessThan(awake.mock.invocationCallOrder[0]);
  expect(sockets).toHaveLength(1);
  sockets[0].onmessage({ data: { toString: () => '{"type":"ready"}' } });
  session.setReplyPlaying(true);
  const count = sockets[0].send.mock.calls.length;
  for (let i = 0; i < 20; i++) frame();
  expect(sockets[0].send).toHaveBeenCalledTimes(count);
  session.dispose();
  expect(track.stop).toHaveBeenCalled();
  expect(workers[0].terminate).toHaveBeenCalled();
});

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
  const rejected = socket;
  rejected.onerror();
  expect(rejected.close).toHaveBeenCalled();
  vi.advanceTimersByTime(500);
  expect(socketCreated).toHaveBeenCalledTimes(2);
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

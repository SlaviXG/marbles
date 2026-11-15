import { afterEach, expect, it, vi } from 'vitest';
import { VoiceSession } from '../voice/VoiceSession';
import { SAMPLE_RATE } from '../voice/audio';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function wakeSession() {
  const workers: any[] = [], sockets: any[] = [];
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
  const awake = vi.fn(), wakeDetected = vi.fn(), status = vi.fn(), transcript = vi.fn();
  const session = new VoiceSession({ status, transcript, awake, wakeDetected }, { wake: true });
  const startup = session.start();
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  workers[0].onmessage({ data: { type: 'ready' } });
  await startup;
  const audio = (level = .1, count = 1) => {
    for (let i = 0; i < count; i++) capture.port.onmessage({ data: new Float32Array(2048).fill(level) });
  };
  const wake = () => {
    audio(.1, 20);
    const job = workers[0].postMessage.mock.calls.find(([data]: any[]) => data.type === 'audio')[0];
    workers[0].onmessage({ data: { type: 'result', text: 'Marbles', start: 0, epoch: job.epoch, end: job.end, length: job.length } });
    expect(sockets).toHaveLength(1);
    sockets[0].onmessage({ data: JSON.stringify({ type: 'ready' }) });
  };
  return { session, status, transcript, audio, wake, awake, wakeDetected, workers, sockets, track };
}

it('keeps command audio gated by the wake word even when the user faces the screen', async () => {
  const { session, status, audio, wake, awake, wakeDetected, sockets, workers, track } = await wakeSession();
  for (const looking of [true, false, true, null, true]) {
    session.setAttention(looking); audio(.1, 3);
    expect(status).toHaveBeenLastCalledWith('wake', expect.any(String));
    expect(sockets).toHaveLength(0);
  }
  wake();
  expect(awake).toHaveBeenCalledOnce();
  expect(wakeDetected).toHaveBeenCalledOnce();
  expect(wakeDetected.mock.invocationCallOrder[0]).toBeLessThan(awake.mock.invocationCallOrder[0]);
  session.setReplyPlaying(true);
  const count = sockets[0].send.mock.calls.length;
  audio(.1, 20);
  expect(sockets[0].send).toHaveBeenCalledTimes(count);
  session.dispose();
  expect(track.stop).toHaveBeenCalled();
  expect(workers[0].terminate).toHaveBeenCalled();
});

it('returns to wake standby after a request despite gaze, and still delivers its pending transcript', async () => {
  vi.useFakeTimers();
  const { session, status, transcript, audio, wake, sockets } = await wakeSession();
  wake();
  session.setAttention(true);
  session.rearm();
  vi.advanceTimersByTime(1500); // Drain the captured request and its final commit.
  expect(status).toHaveBeenLastCalledWith('wake', expect.any(String));
  const count = sockets[0].send.mock.calls.length;
  session.setAttention(false); session.setAttention(true);
  audio(.1, 30);
  vi.advanceTimersByTime(1500);
  expect(sockets[0].send).toHaveBeenCalledTimes(count);
  const final = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'request', transcript: 'Marbles show my files' };
  sockets[0].onmessage({ data: JSON.stringify(final) });
  expect(transcript).toHaveBeenCalledWith(final);
  session.dispose();
});

it('expires the wake window before new speech even if the person keeps looking', async () => {
  vi.useFakeTimers();
  const { session, status, audio, wake, sockets } = await wakeSession();
  wake(); audio(.002, 15); // End the wake phrase, then wait for a command.
  for (let i = 0; i < 22; i++) {
    session.setAttention(true); audio(.002);
    vi.advanceTimersByTime(1000);
  }
  const count = sockets[0].send.mock.calls.length;
  audio(.1, 20);
  vi.advanceTimersByTime(1000);
  expect(status).toHaveBeenLastCalledWith('wake', expect.any(String));
  expect(sockets[0].send).toHaveBeenCalledTimes(count);
  session.dispose();
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

it('releases an automatic startup if the browser requires an audio-unlock tap', async () => {
  vi.useFakeTimers();
  const stop = vi.fn(), close = vi.fn().mockResolvedValue(undefined), status = vi.fn();
  const track = { stop, onended: null };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal('AudioContext', class {
    state = 'suspended'; sampleRate = SAMPLE_RATE;
    resume = () => new Promise<void>(() => {});
    close = close;
  });
  const session = new VoiceSession({ status, transcript: vi.fn() }, { wake: true, automatic: true });
  const startup = session.start();
  await vi.advanceTimersByTimeAsync(2600);
  await startup;
  expect(status).toHaveBeenLastCalledWith('error', expect.stringContaining('Tap the orb'));
  expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

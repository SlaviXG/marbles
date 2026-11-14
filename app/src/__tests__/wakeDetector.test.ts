import { afterEach, expect, it, vi } from 'vitest';
import { WakeDetector } from '../voice/WakeDetector';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup() {
  const workers: any[] = [];
  vi.stubGlobal('Worker', class {
    postMessage = vi.fn(); terminate = vi.fn(); onmessage: any;
    constructor() { workers.push(this); }
  });
  const error = vi.fn(), wake = vi.fn();
  const detector = new WakeDetector(wake, error);
  const load = detector.load(vi.fn());
  return { detector, worker: workers[0], error, wake, load };
}

it('recovers after one failed inference and keeps the cloud gate closed', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { detector, worker, error, wake, load } = setup();
  worker.onmessage({ data: { type: 'ready' } }); await load;
  const audio = new Float32Array(24000).fill(0.1);
  detector.push(audio);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.onmessage({ data: { type: 'error', phase: 'inference', message: 'alignment failed' } });
  detector.push(audio);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1000); detector.push(audio);
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  const job = worker.postMessage.mock.calls.at(-1)[0];
  worker.onmessage({ data: { type: 'result', epoch: job.epoch, end: job.end, length: job.length } });
  expect(error).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
  detector.dispose();
});

it('reports the real error only after repeated failures', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { detector, worker, error, load } = setup();
  worker.onmessage({ data: { type: 'ready' } }); await load;
  for (let i = 0; i < 3; i++) {
    detector.push(new Float32Array(24000).fill(0.1));
    worker.onmessage({ data: { type: 'error', phase: 'inference', message: 'out of memory' } });
    vi.advanceTimersByTime(1000);
  }
  expect(error).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('out of memory'));
  detector.dispose();
});

it('keeps load failures distinct from inference failures', async () => {
  const { detector, worker, error, load } = setup();
  worker.onmessage({ data: { type: 'error', phase: 'load', message: 'download failed with HTTP 503' } });
  await expect(load).rejects.toThrow('HTTP 503');
  expect(error).not.toHaveBeenCalled(); detector.dispose();
});

it('drops invalid frames instead of passing NaNs to the runtime', async () => {
  const { detector, worker, load } = setup();
  worker.onmessage({ data: { type: 'ready' } }); await load;
  detector.push(new Float32Array([NaN, Infinity]));
  detector.push(new Float32Array(0));
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  detector.dispose();
});

it('rechecks a completed word after the speaker goes quiet while inference is busy', async () => {
  const { detector, worker, wake, load } = setup();
  worker.onmessage({ data: { type: 'ready' } }); await load;
  detector.push(new Float32Array(24000).fill(0.02));
  const first = worker.postMessage.mock.calls.at(-1)[0];
  // The end of "Marbles" arrives while the first, partial-word job is busy.
  detector.push(new Float32Array(7200).fill(0.02));
  detector.push(new Float32Array(72000));
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.onmessage({ data: { type: 'result', epoch: first.epoch, end: first.end, length: first.length } });
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  const final = worker.postMessage.mock.calls.at(-1)[0];
  expect(final.end).toBe(38400); // Speech plus 300 ms, not the later silence.
  expect(final.audio.some((value: number) => value > 0)).toBe(true);
  worker.onmessage({ data: { type: 'result', start: 0.5, epoch: final.epoch, end: final.end, length: final.length } });
  expect(wake).toHaveBeenCalledOnce();
  detector.dispose();
});

it('recognizes quiet input and stops decoding after the final padded window', async () => {
  const { detector, worker, load } = setup();
  worker.onmessage({ data: { type: 'ready' } }); await load;
  detector.push(new Float32Array(24000).fill(0.0001));
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  detector.push(new Float32Array(24000).fill(0.002));
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  detector.push(new Float32Array(24000));
  let job = worker.postMessage.mock.calls.at(-1)[0];
  worker.onmessage({ data: { type: 'result', epoch: job.epoch, end: job.end, length: job.length } });
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  job = worker.postMessage.mock.calls.at(-1)[0];
  worker.onmessage({ data: { type: 'result', epoch: job.epoch, end: job.end, length: job.length } });
  detector.push(new Float32Array(24000 * 4));
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  detector.dispose();
});

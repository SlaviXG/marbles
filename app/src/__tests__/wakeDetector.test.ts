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

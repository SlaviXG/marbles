import { afterEach, expect, it, vi } from 'vitest';
import { WakeDetector } from '../voice/WakeDetector';
import { SAMPLE_RATE } from '../voice/audio';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(withSpeech = false) {
  const workers: any[] = [], recognitions: any[] = [];
  vi.stubGlobal('Worker', class {
    postMessage = vi.fn(); terminate = vi.fn(); onmessage: any; onerror: any;
    constructor() { workers.push(this); }
  });
  if (withSpeech) vi.stubGlobal('window', { SpeechRecognition: class {
    continuous = false; interimResults = false; lang = ''; onresult: any; onend: any; onerror: any;
    start = vi.fn(); stop = vi.fn(); constructor() { recognitions.push(this); }
  } });
  const error = vi.fn(), wake = vi.fn();
  const detector = new WakeDetector(wake, error);
  const load = detector.load(vi.fn());
  const worker = workers[0];
  worker.onmessage({ data: { type: 'ready' } });
  return { detector, worker, error, wake, load, recognitions };
}
function frame(value: number, ms = 100) { return new Float32Array(SAMPLE_RATE * ms / 1000).fill(value); }
function result(worker: any, text = '', start?: number) {
  const job = worker.postMessage.mock.calls.filter(([data]: any[]) => data.type === 'audio').at(-1)?.[0];
  worker.onmessage({ data: { type: 'result', text, start, epoch: job.epoch, end: job.end, length: job.length, inferenceMs: 35 } });
}
function jobs(worker: any) { return worker.postMessage.mock.calls.filter(([data]: any[]) => data.type === 'audio').map(([data]: any[]) => data); }
it('suspends both recognizers for spoken replies, rejects delayed speaker echoes, then restores browser recognition', async () => {
  const { detector, worker, wake, load, recognitions } = setup(true); await load;
  detector.push(frame(.03, 500));
  const old = recognitions[0];
  detector.setSuspended(true); expect(old.stop).toHaveBeenCalledOnce(); expect(detector.browserRecognitionActive).toBe(false);
  const count = jobs(worker).length; detector.push(frame(.03, 1000)); expect(jobs(worker)).toHaveLength(count);
  old.onresult({ resultIndex: 0, results: [{ 0: { transcript: 'I am Marbles' } }] }); expect(wake).not.toHaveBeenCalled();
  detector.setSuspended(false); expect(recognitions).toHaveLength(2); expect(detector.browserRecognitionActive).toBe(true);
  detector.push(frame(.03, 500));
  old.onresult({ resultIndex: 0, results: [{ 0: { transcript: 'Marbles' } }] }); expect(wake).not.toHaveBeenCalled();
  recognitions[1].onresult({ resultIndex: 0, results: [{ 0: { transcript: 'Marbles' } }] }); expect(wake).toHaveBeenCalledOnce();
  detector.dispose();
});

it('starts within one hop of speech onset and caps the window at 1.5 seconds', async () => {
  const { detector, worker, load } = setup(); await load;
  for (let i = 0; i < 30; i++) detector.push(frame(.03));
  expect(jobs(worker)[0].end).toBeLessThanOrEqual(SAMPLE_RATE * .3);
  result(worker);
  expect(jobs(worker).at(-1).length).toBeLessThanOrEqual(SAMPLE_RATE * 1.5);
  detector.dispose();
});

it('keeps only the latest pending window while busy and runs the final padded window', async () => {
  const { detector, worker, wake, load } = setup(); await load;
  for (let i = 0; i < 15; i++) detector.push(frame(.03));
  expect(jobs(worker)).toHaveLength(1);
  detector.push(frame(0, 300));
  result(worker);
  expect(jobs(worker)).toHaveLength(2);
  expect(jobs(worker)[1].end).toBe(SAMPLE_RATE * 1.75);
  result(worker, 'Marbles', 0.2);
  expect(wake.mock.calls[0][1].droppedWindows).toBeGreaterThan(0);
  detector.dispose();
});

it('rejects silence, accepts a short word over the adaptive noise floor', async () => {
  const { detector, worker, load } = setup(); await load;
  for (let i = 0; i < 30; i++) detector.push(frame(.002));
  expect(jobs(worker)).toHaveLength(0);
  detector.push(frame(.02));
  expect(jobs(worker)).toHaveLength(1);
  expect(jobs(worker)[0].end).toBe(SAMPLE_RATE * 3.1);
  detector.dispose();
});

it('keeps local wake detection working when browser recognition is unavailable', async () => {
  vi.stubGlobal('window', {});
  const { detector, worker, wake, load, recognitions } = setup(); await load;
  expect(recognitions).toHaveLength(0);
  expect(detector.browserRecognitionActive).toBe(false);
  detector.push(frame(.03, 500));
  result(worker, 'Marbles', 0);
  expect(wake).toHaveBeenCalledOnce();
  expect(wake.mock.calls[0][1].detector).toBe('whisper');
  detector.dispose();
});

it.each([
  {},
  { getItem: () => { throw new Error('Storage access denied'); } },
])('still activates when diagnostic storage is unavailable: %j', async storage => {
  vi.stubGlobal('localStorage', storage);
  const { detector, worker, wake, load } = setup(); await load;
  detector.push(frame(.03, 500));
  result(worker, 'Marbles', 0);
  expect(wake).toHaveBeenCalledOnce();
  detector.dispose();
});

it.each(['webspeech', 'whisper'] as const)('%s wins the dual detector race and cooldown dedupes the other', async winner => {
  vi.useFakeTimers();
  const { detector, worker, wake, load, recognitions } = setup(true); await load;
  for (let i = 0; i < 5; i++) detector.push(frame(.03));
  const speech = () => recognitions[0].onresult({ resultIndex: 0, results: [{ 0: { transcript: 'Hey Marbles' }, isFinal: false }] });
  if (winner === 'webspeech') { speech(); result(worker, 'Marbles', 0); }
  else { result(worker, 'Marbles', 0); speech(); }
  expect(wake).toHaveBeenCalledTimes(1);
  expect(wake.mock.calls[0][1].detector).toBe(winner);
  vi.advanceTimersByTime(1499); speech(); expect(wake).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  for (let i = 0; i < 5; i++) detector.push(frame(.03));
  speech(); expect(wake).toHaveBeenCalledTimes(2);
  detector.dispose();
});

it('restarts Web Speech after end and disables it on network errors', async () => {
  const { detector, load, recognitions } = setup(true); await load;
  const speech = recognitions[0];
  expect(detector.browserRecognitionActive).toBe(true);
  expect(speech.continuous).toBe(true); expect(speech.interimResults).toBe(true);
  speech.onend(); expect(speech.start).toHaveBeenCalledTimes(2);
  speech.onerror({ error: 'network' });
  expect(speech.stop).toHaveBeenCalled(); expect(speech.onend).toBeNull();
  expect(detector.browserRecognitionActive).toBe(false);
  detector.dispose();
});

it('recovers from inference errors and reports repeated failures', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { detector, worker, error, load } = setup(); await load;
  for (let i = 0; i < 3; i++) {
    detector.push(frame(.03, 300));
    worker.onmessage({ data: { type: 'error', phase: 'inference', message: 'out of memory' } });
    vi.advanceTimersByTime(1000);
  }
  expect(error).toHaveBeenCalledOnce(); detector.dispose();
});

it('keeps load errors distinct and drops invalid frames', async () => {
  const workers: any[] = [];
  vi.stubGlobal('Worker', class { postMessage = vi.fn(); terminate = vi.fn(); onmessage: any; constructor() { workers.push(this); } });
  const detector = new WakeDetector(vi.fn(), vi.fn());
  const load = detector.load(vi.fn());
  workers[0].onmessage({ data: { type: 'error', phase: 'load', message: 'HTTP 503' } });
  await expect(load).rejects.toThrow('HTTP 503'); detector.dispose();
  const next = setup(); await next.load;
  next.detector.push(new Float32Array([NaN, Infinity]));
  expect(jobs(next.worker)).toHaveLength(0); next.detector.dispose();
});

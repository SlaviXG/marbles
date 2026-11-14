import { expect, it } from 'vitest';
import { normalizeWakeAudio, recognizedWakeStart } from '../voice/wakeAudio';

it('raises quiet speech with bounded gain without changing the original audio', () => {
  const quiet = new Float32Array([0.002, -0.002]);
  expect(Array.from(normalizeWakeAudio(quiet))).toEqual(Array.from(quiet.map(value => value * 8)));
  expect(quiet[0]).toBeCloseTo(0.002);
  expect(Array.from(normalizeWakeAudio(new Float32Array([0.8, -0.8])))).toEqual(Array.from(new Float32Array([0.8, -0.8])));
  expect(Array.from(normalizeWakeAudio(new Float32Array(2)))).toEqual([0, 0]);
});

it('uses the segment containing the wake word to preserve the command', () => {
  const audio = new Float32Array(16000 * 3).fill(0.02);
  expect(recognizedWakeStart({ text: 'Earlier words. Hey Marbles, write a report.', chunks: [
    { text: 'Earlier words.', timestamp: [0, 1] },
    { text: 'Hey Marbles, write a report.', timestamp: [1, 3] },
  ] }, audio)).toBe(1);
});

const missingAlignments: { chunks: Parameters<typeof recognizedWakeStart>[0]['chunks'] }[] = [
  { chunks: undefined }, { chunks: [] },
  { chunks: [{ text: 'Different alignment', timestamp: [null, null] }] },
  { chunks: [{ text: 'Marbles', timestamp: [99, 100] }] },
];
it.each(missingAlignments)(
  'does not lose a recognized wake word when alignment is absent or invalid: %j', ({ chunks }) => {
    const audio = new Float32Array(16000 * 2);
    audio.fill(0.01, 8000, 12000);
    expect(recognizedWakeStart({ text: 'Marbles', chunks }, audio)).toBeCloseTo(0.4);
  },
);

it('keeps silence and unrelated speech out of cloud transcription', () => {
  expect(recognizedWakeStart({ text: 'Marbles', chunks: [{ text: 'Marbles', timestamp: [0, 1] }] }, new Float32Array(16000))).toBeUndefined();
  expect(recognizedWakeStart({ text: 'Write a report' }, new Float32Array(16000).fill(0.02))).toBeUndefined();
});

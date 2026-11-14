import { expect, it } from 'vitest';
import { wakeStart, withoutWakePhrase } from '../voice/wakePhrase';
import { spokenText } from '../voice/ReplySpeaker';

it('matches the exact wake phrase as complete words and keeps its timestamp', () => {
  expect(wakeStart([{ text: 'Hey,', timestamp: [0.2, 0.5] }, { text: 'Marbles!', timestamp: [0.5, 1] }])).toBe(0.2);
  expect(wakeStart([{ text: 'they marbles', timestamp: [0, 1] }])).toBeUndefined();
  expect(wakeStart([{ text: 'hey marble', timestamp: [0, 1] }])).toBeUndefined();
});
it('discards audio-prefix transcription before the last wake phrase', () => {
  expect(withoutWakePhrase('Some old reply. Hey, Marbles! Write a report.')).toBe('Write a report.');
  expect(withoutWakePhrase('Hey Marbles.')).toBe('');
  expect(withoutWakePhrase('Write a report')).toBe('Write a report');
});
it('does not read the wake phrase back into the microphone', () => {
  const text = spokenText('Say **Hey Marbles** and read [the report](https://example.com). ```js\nsecret\n```');
  expect(text).not.toMatch(/hey marbles/i);
  expect(text).toContain('the report');
  expect(text).not.toContain('secret');
  expect(spokenText('x'.repeat(2000)).length).toBeLessThan(700);
});

import { expect, it } from 'vitest';
import { hasWakePhrase, wakeMatch, wakeStart, withoutWakePhrase } from '../voice/wakePhrase';
import { spokenText } from '../voice/ReplySpeaker';

it('matches the exact wake phrase as complete words and keeps its timestamp', () => {
  expect(hasWakePhrase('Hey, Marbles!')).toBe(true);
  expect(hasWakePhrase('they marbles')).toBe(false);
  expect(wakeStart([{ text: 'Hey,', timestamp: [0.2, 0.5] }, { text: 'Marbles!', timestamp: [0.5, 1] }])).toBe(0.2);
  expect(wakeStart([{ text: 'they marbles', timestamp: [0, 1] }])).toBeUndefined();
  expect(wakeStart([{ text: 'hey marble', timestamp: [0, 1] }])).toBe(0);
});
it.each(['hey marvels', 'hey marble', 'hay marbles', 'hi marbles', 'Heymarbles'])('accepts a close wake transcription: %s', text => {
  expect(wakeMatch(text)?.score).toBeGreaterThanOrEqual(0.7);
  expect(hasWakePhrase(text)).toBe(true);
});
it.each(['they marbles', 'the marbles', 'hey there', 'hey mark', 'make a report'])('rejects unrelated speech: %s', text => {
  expect(hasWakePhrase(text)).toBe(false);
});
it('strips a fuzzy wake phrase and does not speak it back', () => {
  expect(withoutWakePhrase('Hey marvels, create a brief.')).toBe('create a brief.');
  expect(spokenText('Say hey marvels to continue.')).not.toContain('hey marvels');
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

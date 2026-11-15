import { expect, it } from 'vitest';
import { hasWakePhrase, wakeMatch, wakeStart, withoutWakePhrase, WAKE_MATCH_THRESHOLD } from '../voice/wakePhrase';
import { spokenText } from '../voice/ReplySpeaker';

it('uses a guarded phonetic threshold', () => {
  expect(WAKE_MATCH_THRESHOLD).toBe(0.72);
  expect(wakeMatch('Marbles')?.score).toBe(1);
  expect(wakeMatch('marvels')?.score).toBeGreaterThanOrEqual(0.72);
});

it.each([
  'Marbles', 'hey marbles', 'hi marbles', 'yo marbles', 'Heymarbles',
  'Could you help me today, Marbles, and write a report?',
  'I have a long request for you and I will say marbles in the middle of it.',
  'marvels', 'marble', 'marbels', 'marbel', 'marvel', 'mabels', 'mables', 'marbos', 'marbleous', 'mar bles', 'heymarbles',
])('finds the trigger word without matching the whole sentence: %s', text => {
  expect(hasWakePhrase(text)).toBe(true);
});

it.each(['the sky', 'hey there', 'write a report', 'make a brief', 'something', 'tables', 'cables', 'bubbles', 'mumbles', 'nobles', 'marvelous', 'marbella', 'marks', 'maples'])('rejects near misses: %s', text => {
  expect(hasWakePhrase(text)).toBe(false);
});

it('keeps the trigger-word timestamp rather than the greeting timestamp', () => {
  expect(wakeStart([
    { text: 'Hey,', timestamp: [0.2, 0.5] },
    { text: 'Marbles!', timestamp: [0.5, 1] },
    { text: 'create tables', timestamp: [1, 2] },
  ])).toBe(0.5);
});

it('prefers the clearest match and keeps the task after it intact', () => {
  expect(withoutWakePhrase('Some old reply. Hey, Marbles! Create tables and labels.')).toBe('Create tables and labels.');
  expect(withoutWakePhrase('Marbles, explain how marbles are made.')).toBe('explain how marbles are made.');
  expect(withoutWakePhrase('Yo marvels, create a brief.')).toBe('create a brief.');
  expect(withoutWakePhrase('Hi Marbles.')).toBe('');
  expect(withoutWakePhrase('Write a report')).toBe('Write a report');
});

it('speaks Marbles naturally without rewriting its name or other words', () => {
  for (const word of ['marbles', 'marvels', 'marble']) {
    const text = spokenText(`Say **${word}** and read [the report](https://example.com).`);
    expect(text).toBe(`Say ${word} and read the report.`);
  }
  expect(spokenText('```js\nsecret\n```')).not.toContain('secret');
  expect(spokenText('x'.repeat(2000)).length).toBeLessThan(700);
});

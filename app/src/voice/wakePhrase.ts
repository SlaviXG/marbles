import { WAKE_MATCH_THRESHOLD, WAKE_VARIANT_SCORE, WAKE_PHONETIC_SCORE, WAKE_STRONG_EDIT_SCORE, WAKE_MIN_WORD_LENGTH, WAKE_MAX_WORD_LENGTH } from './wakeConfig';
export { WAKE_MATCH_THRESHOLD } from './wakeConfig';

const exact = new Set(['marbles', 'marble', 'marbels', 'marbel', 'marvels', 'marvel', 'mabels', 'mables', 'marbos', 'marbleous']);
const blocked = new Set(['marvelous', 'mumbles', 'bubbles', 'tables', 'cables', 'marks', 'maples', 'nobles', 'marbella']);

function similarity(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(left[i - 1] !== right[j - 1]));
    row = next;
  }
  return 1 - row[right.length] / Math.max(left.length, right.length);
}

function phonetic(word: string): string {
  return word.replace(/v/g, 'b').replace(/([a-z])\1+/g, '$1').replace(/(?!^)[aeiouy]/g, '');
}

function score(word: string): number | undefined {
  if (blocked.has(word) || word.length < WAKE_MIN_WORD_LENGTH || word.length > WAKE_MAX_WORD_LENGTH) return;
  if (word === 'marbles') return 1;
  if (exact.has(word)) return WAKE_VARIANT_SCORE;
  const edit = similarity(word, 'marbles');
  const key = phonetic(word);
  const value = key === phonetic('marbles') && edit >= WAKE_MATCH_THRESHOLD ? Math.max(WAKE_PHONETIC_SCORE, edit) : edit >= WAKE_STRONG_EDIT_SCORE ? edit : 0;
  return value >= WAKE_MATCH_THRESHOLD ? value : undefined;
}

type Token = { text: string; index: number; end: number };
function words(text: string): Token[] {
  const raw = [...text.toLowerCase().matchAll(/[a-z]+/g)].flatMap(match => {
    const index = match.index!;
    const joined = /^(hey|hay|hei)([a-z]{5,})$/.exec(match[0]);
    return joined ? [
      { text: joined[1], index, end: index + joined[1].length },
      { text: joined[2], index: index + joined[1].length, end: index + match[0].length },
    ] : [{ text: match[0], index, end: index + match[0].length }];
  });
  const result = [...raw];
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i].text === 'mar' && /^(bles|bels|ble|bel)$/.test(raw[i + 1].text))
      result.push({ text: raw[i].text + raw[i + 1].text, index: raw[i].index, end: raw[i + 1].end });
  }
  return result;
}

export function wakeMatch(text: string): { score: number; start: number; end: number } | undefined {
  let best: { score: number; start: number; end: number } | undefined;
  for (const token of words(text)) {
    const value = score(token.text);
    if (value != null && (!best || value > best.score)) best = { score: value, start: token.index, end: token.end };
  }
  return best;
}

export function wakeStart(chunks: { text: string; timestamp: [number | null, number | null] }[]): number | undefined {
  let best: { score: number; at: number } | undefined;
  for (const chunk of chunks) for (const token of words(chunk.text)) {
    const value = score(token.text);
    if (value != null && chunk.timestamp[0] != null && (!best || value > best.score)) best = { score: value, at: chunk.timestamp[0]! };
  }
  return best?.at;
}

export function withoutWakePhrase(text: string): string {
  const match = wakeMatch(text);
  return match ? text.slice(match.end).replace(/^[\s,.!?:;-]+/, '').trim() : text;
}
export function hasWakePhrase(text: string): boolean { return wakeMatch(text) != null; }

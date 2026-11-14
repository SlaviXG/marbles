export const WAKE_MATCH_THRESHOLD = 0.5;
const TARGET = 'marbles';

// Compare individual words anywhere in the transcript, not the full sentence.
// This is normalized edit similarity, not acoustic confidence.
function similarity(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(left[i - 1] !== right[j - 1]));
    }
    row = next;
  }
  return 1 - row[right.length] / Math.max(left.length, right.length);
}

function score(word: string): number | undefined {
  if (word.length < 3 || word.length > 14) return;
  const value = similarity(word, TARGET);
  return value >= WAKE_MATCH_THRESHOLD ? value : undefined;
}

function words(text: string): { text: string; index: number; end: number }[] {
  return [...text.toLowerCase().matchAll(/[a-z]+/g)].flatMap(match => {
    const index = match.index!;
    // ASR sometimes joins the attention word and name into a single token.
    const joined = /^(hey|hay|hei)([a-z]{4,})$/.exec(match[0]);
    return joined ? [
      { text: joined[1], index, end: index + joined[1].length },
      { text: joined[2], index: index + joined[1].length, end: index + match[0].length },
    ] : [{ text: match[0], index, end: index + match[0].length }];
  });
}

export function wakeMatch(text: string): { score: number; start: number; end: number } | undefined {
  let best: { score: number; start: number; end: number } | undefined;
  for (const token of words(text)) {
    const value = score(token.text);
    // Prefer the clearest word match, then its earliest occurrence. In
    // "Marbles, create tables", the request word must not replace the wake word.
    if (value != null && (!best || value > best.score)) best = { score: value, start: token.index, end: token.end };
  }
  return best;
}

export function wakeStart(chunks: { text: string; timestamp: [number | null, number | null] }[]): number | undefined {
  const tokens = chunks.flatMap(chunk => words(chunk.text).map(word => ({ ...word, at: chunk.timestamp[0] })));
  let best: { score: number; at: number } | undefined;
  for (const token of tokens) {
    const value = score(token.text);
    if (value != null && token.at != null && (!best || value > best.score)) best = { score: value, at: token.at };
  }
  return best?.at;
}

export function withoutWakePhrase(text: string): string {
  const match = wakeMatch(text);
  return match ? text.slice(match.end).replace(/^[\s,.!?:;-]+/, '').trim() : text;
}

export function hasWakePhrase(text: string): boolean { return wakeMatch(text) != null; }

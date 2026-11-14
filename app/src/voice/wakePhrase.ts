export const WAKE_MATCH_THRESHOLD = 0.6;
const TARGET = 'hey marbles';
const GREETINGS = new Set(['hey', 'hay', 'hi', 'hei', 'ay']);

// Normalized edit similarity, not an acoustic confidence probability. Require
// an attention word so ordinary phrases such as "they marbles" cannot wake it.
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

function score(first: string, second: string): number | undefined {
  if (!GREETINGS.has(first) || second.length < 3 || second.length > 14) return;
  const value = similarity(`hey ${second}`, TARGET);
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
  const tokens = words(text);
  for (let i = tokens.length - 2; i >= 0; i--) {
    const value = score(tokens[i].text, tokens[i + 1].text);
    if (value != null) return { score: value, start: tokens[i].index, end: tokens[i + 1].end };
  }
}

export function wakeStart(chunks: { text: string; timestamp: [number | null, number | null] }[]): number | undefined {
  const tokens = chunks.flatMap(chunk => words(chunk.text).map(word => ({ ...word, at: chunk.timestamp[0] })));
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (score(tokens[i].text, tokens[i + 1].text) != null && tokens[i].at != null) return tokens[i].at!;
  }
}

export function withoutWakePhrase(text: string): string {
  const match = wakeMatch(text);
  return match ? text.slice(match.end).replace(/^[\s,.!?:;-]+/, '').trim() : text;
}

export function hasWakePhrase(text: string): boolean { return wakeMatch(text) != null; }

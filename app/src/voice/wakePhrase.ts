export function wakeStart(chunks: { text: string; timestamp: [number | null, number | null] }[]): number | undefined {
  const words = chunks.flatMap(chunk => chunk.text.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/\s+/)
    .filter(Boolean).map(text => ({ text, at: chunk.timestamp[0] })));
  for (let i = words.length - 2; i >= 0; i--) {
    if (words[i].text === 'hey' && words[i + 1].text === 'marbles' && words[i].at != null) return words[i].at!;
  }
}

export function withoutWakePhrase(text: string): string {
  const matches = [...text.matchAll(/\bhey[\s,.!?:;-]+marbles\b[\s,.!?:;-]*/gi)];
  const last = matches[matches.length - 1];
  return last ? text.slice(last.index! + last[0].length).trim() : text;
}

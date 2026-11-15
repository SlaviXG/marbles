import { describe, expect, it } from 'vitest';
import { AudioTurns, SAMPLE_RATE } from '../voice/audio';

const frame = (level: number, ms = 20) => new Float32Array(SAMPLE_RATE * ms / 1000).fill(level);
function speech() {
  const turns = new AudioTurns();
  for (let i = 0; i < 25; i++) turns.push(frame(.002));
  for (let i = 0; i < 50; i++) turns.push(frame(i % 5 === 0 ? .07 : .16));
  return turns;
}
describe('speech endpoint timing', () => {
  it('submits a normal finished sentence in about half a second', () => {
    const turns = speech(); let elapsed = 0, commit = false;
    while (!commit && elapsed < 2000) { commit = turns.push(frame(.002)).commit; elapsed += 20; }
    expect(elapsed).toBeGreaterThanOrEqual(480); expect(elapsed).toBeLessThanOrEqual(600);
    expect(turns.push(frame(.002)).commit).toBe(false);
  });
  it('does not wait for the 15-second cap when music or a fan remains after speech', () => {
    const turns = speech(); let elapsed = 0, commit = false;
    while (!commit && elapsed < 2000) { const result = turns.push(frame(.075)); expect(result.background).not.toBe(true); commit = result.commit; elapsed += 20; }
    expect(commit).toBe(true); expect(elapsed).toBeLessThan(1000);
  });
  it('ignores a brief background click during the final pause', () => {
    const turns = speech(); let elapsed = 0, commit = false;
    while (!commit && elapsed < 2000) { commit = turns.push(frame(elapsed === 340 ? .09 : .002)).commit; elapsed += 20; }
    expect(elapsed).toBeLessThanOrEqual(600);
  });
  it('keeps a thinking pause and quieter final words in the same turn', () => {
    const turns = speech();
    for (let i = 0; i < 15; i++) expect(turns.push(frame(.002)).commit).toBe(false);
    for (let i = 0; i < 30; i++) expect(turns.push(frame(i % 3 ? .045 : .065)).commit).toBe(false);
    let ended = false;
    for (let i = 0; i < 40 && !ended; i++) ended = turns.push(frame(.002)).commit;
    expect(ended).toBe(true);
  });
});

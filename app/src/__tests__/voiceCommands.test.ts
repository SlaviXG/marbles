import { afterEach, expect, it, vi } from 'vitest';
import { CommandBuffer } from '../voice/CommandBuffer';
import { AudioTurns } from '../voice/audio';

afterEach(() => vi.useRealTimers());

it('hands off on the next event loop after the final transcript with no extra pause', () => {
  vi.useFakeTimers();
  const submit = vi.fn();
  const buffer = new CommandBuffer(submit);
  buffer.event({ type: 'committed', item_id: 'a' });
  buffer.event({ type: 'delta', item_id: 'a', delta: 'Write a report' });
  vi.advanceTimersByTime(100);
  expect(submit).not.toHaveBeenCalled();
  buffer.event({ type: 'completed', item_id: 'a', transcript: 'Write a report' });
  vi.advanceTimersByTime(0);
  expect(submit).toHaveBeenCalledWith('Write a report');
  buffer.dispose();
});

it('waits for a quiet pause and all finals, batches phrases, and deduplicates events', () => {
  vi.useFakeTimers();
  const submit = vi.fn();
  const buffer = new CommandBuffer(submit);
  buffer.activity(true);
  buffer.event({ type: 'committed', item_id: 'a' });
  buffer.event({ type: 'committed', item_id: 'b' });
  buffer.event({ type: 'completed', item_id: 'b', transcript: 'with hello' });
  buffer.activity(false);
  vi.advanceTimersByTime(2000);
  expect(submit).not.toHaveBeenCalled();
  buffer.event({ type: 'completed', item_id: 'a', transcript: 'Create a file' });
  for (let i = 0; i < 20; i++) { buffer.activity(false); vi.advanceTimersByTime(100); }
  expect(submit).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledWith('Create a file with hello');
  buffer.event({ type: 'completed', item_id: 'a', transcript: 'Create a file' });
  vi.advanceTimersByTime(2000);
  expect(submit).toHaveBeenCalledOnce();
  buffer.dispose();
});

it('cancels pending dispatch when disposed or speech resumes', () => {
  vi.useFakeTimers();
  const submit = vi.fn();
  const buffer = new CommandBuffer(submit);
  buffer.event({ type: 'committed', item_id: 'a' });
  buffer.event({ type: 'completed', item_id: 'a', transcript: 'task' });
  buffer.activity(true);
  vi.advanceTimersByTime(2000);
  expect(submit).not.toHaveBeenCalled();
  buffer.activity(false); buffer.dispose();
  vi.advanceTimersByTime(2000);
  expect(submit).not.toHaveBeenCalled();
});

it('learns ambient noise, rejects an isolated click, then triggers on a sustained rise', () => {
  const turns = new AudioTurns();
  const frame = (value: number) => new Float32Array(2048).fill(value);
  for (let i = 0; i < 80; i++) expect(turns.push(frame(0.015)).audio).toBeUndefined();
  expect(turns.push(frame(0.15)).audio).toBeUndefined();
  expect(turns.push(frame(0.015)).audio).toBeUndefined();
  expect(turns.push(frame(0.1)).audio).toBeUndefined();
  const onset = turns.push(frame(0.1));
  expect(onset.speaking).toBe(true);
  expect(onset.audio!.length).toBeGreaterThan(2048); // Includes pre-roll.
  let commits = 0;
  for (let i = 0; i < 12; i++) if (turns.push(frame(0.015)).commit) commits++;
  expect(commits).toBe(1);
});

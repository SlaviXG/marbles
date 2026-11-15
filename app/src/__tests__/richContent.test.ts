import { describe, expect, it } from 'vitest';
import { mediaCommand } from '../voice/mediaCommand';
import { canvasCommand } from '../voice/canvasCommand';
import { latestStep } from '../core/graph';
import { texToMarkdown } from '../views/preview/latexSource';
import type { Display } from '../state/display';

const email: Display = { kind: 'email', to: 'sam@example.com', name: 'Sam', subject: 'Hi', body: 'Yo' };
const images: Display = { kind: 'images', query: 'aurora', images: [] };

describe('spoken answers to what is on screen', () => {
  it('only confirms an email or call that is actually showing', () => {
    expect(mediaCommand('Send it.', null)).toBeNull();
    expect(mediaCommand('Send it.', images)).toBeNull();
    expect(mediaCommand('Yes, send it', email)?.action).toBe('confirm');
    expect(mediaCommand("Don't send it", email)?.action).toBe('close');
    expect(mediaCommand('Call', { kind: 'call', number: '+44', name: '' })?.action).toBe('confirm');
    expect(mediaCommand('Send the report to finance', email)).toBeNull();
  });
  it('steps through pictures and closes anything', () => {
    expect(mediaCommand('next', images)?.action).toBe('next');
    expect(mediaCommand('Go back', images)?.action).toBe('previous');
    expect(mediaCommand('close the video', images, true)?.action).toBe('closeVideo');
    expect(mediaCommand('close', images, true)?.action).toBe('close');
    expect(mediaCommand('close', null, true)?.action).toBe('closeVideo');
    expect(mediaCommand('make it bigger', null, true)?.action).toBe('bigger');
    expect(mediaCommand('close', null, false)).toBeNull();
  });
});

it('opens teammates and their files by name', () => {
  const agents = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }];
  expect(canvasCommand('Open Claude Code', [], [], agents)?.select).toBe('agent:claude');
  expect(canvasCommand("show me codex's files", [], [], agents)?.select).toBe('assets:codex');
  expect(canvasCommand('open the pod bay doors', [], [], agents)).toBeNull();
});

it('reports the worker’s latest readable line, not machine output', () => {
  expect(latestStep('Reading the brief\n{"type":"tool"}\n  - Writing q3-market-brief.md\n\n')).toBe('Writing q3-market-brief.md');
  expect(latestStep('{"a":1}\n/usr/bin/x')).toBe('');
  expect(latestStep('x'.repeat(10) + ' ' + 'word '.repeat(20)).length).toBeLessThanOrEqual(44);
});

it('turns LaTeX source into readable structure and keeps the maths', () => {
  const out = texToMarkdown('\\documentclass{article}\\title{Energy}\\begin{document}\\maketitle\\section{Result} % note\nWe find \\textbf{mass} matters.\\begin{equation}E = mc^2\\end{equation}\\begin{itemize}\\item One\\end{itemize}\\end{document}');
  expect(out).toContain('# Energy'); expect(out).toContain('# Result'); expect(out).toContain('**mass**');
  expect(out).toMatch(/\$\$\nE = mc\^2\n\$\$/); expect(out).toContain('- One'); expect(out).not.toContain('note');
});

it('asks for the next waiting result only when one is waiting', () => {
  expect(canvasCommand('Next result', [], [], [], 'artifact:t9:a.md')?.select).toBe('artifact:t9:a.md');
  expect(canvasCommand('Next result', [], [], [], null)).toBeNull();
});

import { slideCommand } from '../voice/mediaCommand';
import { AudioTurns, END_SILENCE_SECONDS, SAMPLE_RATE } from '../voice/audio';

it('moves through slides by voice', () => {
  expect(slideCommand('Next slide.')).toEqual({ delta: 1 });
  expect(slideCommand('go back')).toEqual({ delta: -1 });
  expect(slideCommand('first slide')).toEqual({ to: 'first' });
  expect(slideCommand('next quarter we should hire')).toBeNull();
});

it('ends a turn promptly even when the room is noisy after you stop', () => {
  const chunk = (level: number) => new Float32Array(2048).fill(level);
  const turns = new AudioTurns();
  for (let i = 0; i < 10; i++) turns.push(chunk(.004)); // a quiet start, so the floor is learned low
  for (let i = 0; i < 14; i++) { const voice = chunk(.2); voice.fill(.004, 900, 1400); turns.push(voice); } // speech, with its gaps
  // Then the room gets louder than it was (a fan, chatter) but far quieter than the voice.
  let seconds = 0, ended = false;
  while (!ended && seconds < 3) { ended = turns.push(chunk(.02)).commit; seconds += 2048 / SAMPLE_RATE; }
  expect(ended).toBe(true);
  expect(seconds).toBeLessThan(END_SILENCE_SECONDS + .3);
});

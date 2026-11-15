import { afterEach, expect, it } from 'vitest';
import { applyDisplayAction } from '../state/windows';
import { useDisplay } from '../state/display';
import { useVault } from '../state/store';
import { mediaCommand } from '../voice/mediaCommand';

afterEach(() => { useDisplay.getState().close(); useDisplay.getState().closeVideo(); useVault.getState().clear(); });
it('applies Hermes close receipts to the separate video, preview, gallery or every window', () => {
  const setup = () => {
    useDisplay.getState().show({ kind: 'video', videoId: 'fixture', title: 'Video', channel: '', query: 'fixture' });
    useDisplay.getState().show({ kind: 'images', query: 'fixture', images: [] });
    useVault.getState().select('agent:claude');
  };
  setup(); applyDisplayAction({ kind: 'close', target: 'video' });
  expect(useDisplay.getState().video).toBeNull(); expect(useDisplay.getState().display).not.toBeNull(); expect(useVault.getState().selectedId).toBe('agent:claude');
  setup(); applyDisplayAction({ kind: 'close', target: 'selection' });
  expect(useVault.getState().selectedId).toBeNull(); expect(useDisplay.getState().video).not.toBeNull();
  setup(); applyDisplayAction({ kind: 'close' });
  expect(useVault.getState().selectedId).toBeNull(); expect(useDisplay.getState().video).toBeNull(); expect(useDisplay.getState().display).toBeNull();
});
it('understands natural YouTube and close-everything commands without swallowing unrelated speech', () => {
  for (const phrase of ['Close YouTube', 'Can you please close the YouTube video window for me?', 'get rid of that video']) expect(mediaCommand(phrase, null, true)?.action).toBe('closeVideo');
  expect(mediaCommand('close all windows', null)?.action).toBe('closeAll');
  expect(mediaCommand('explain how to close a YouTube video', null, true)).toBeNull();
});

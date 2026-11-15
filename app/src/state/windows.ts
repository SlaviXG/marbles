import { useDisplay, type Display } from './display';
import { useVault } from './store';

export type WindowTarget = 'video' | 'media' | 'selection' | 'all';
export type DisplayAction = Display | { kind: 'select'; id: string } | { kind: 'close'; target?: WindowTarget };

export function closeWindows(target: WindowTarget = 'all') {
  if (target === 'video' || target === 'all') useDisplay.getState().closeVideo();
  if (target === 'media' || target === 'all') useDisplay.getState().close();
  if (target === 'selection' || target === 'all') useVault.getState().clear();
}

export function applyDisplayAction(action: DisplayAction) {
  if (action.kind === 'close') closeWindows(action.target);
  else if (action.kind === 'select') { closeWindows('media'); useVault.getState().select(action.id); }
  else if (action.kind === 'video') useDisplay.getState().show(action);
  else { closeWindows('selection'); useDisplay.getState().show(action); }
}

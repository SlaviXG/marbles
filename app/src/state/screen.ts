import { useAgents } from './agents';
import { useDisplay } from './display';
import { useHud } from './hud';
import { usePresentation } from './presentation';
import { useVault } from './store';
import { useAttention } from '../attention/AttentionTracker';
import { usePointerStore } from '../input';
import { latestStep } from '../core/graph';
import { fileTitle } from '../views/FileGlyph';

// What Marbles knows about its own screen, in two tiers.
//
// 1. describeScreen(): a few lines of plain facts (what is open, what each
//    agent is doing, the last problem). It rides along with every request and
//    costs a few hundred tokens, which is enough for "close that", "why did it
//    stop" or "what is this".
// 2. captureScreen(): an actual picture, uploaded to the local server just
//    before a request. It costs nothing until Hermes decides it must look, and
//    then a small vision model turns it into a sentence or two.
const short = (text: string | undefined, limit = 70) => { const value = (text ?? '').replace(/\s+/g, ' ').trim(); return value.length > limit ? value.slice(0, limit - 1) + '…' : value; };

export function describeScreen() {
  const { agents, tasks, swarms } = useAgents.getState();
  const view = useDisplay.getState();
  const stage = usePresentation.getState();
  const selected = useVault.getState().selectedId;
  const running = (id: string) => tasks.find(task => task.agentId === id && task.status === 'running');
  const open = stage.active && stage.phase !== 'idle'
    ? { kind: 'result', from: stage.active.leadAgentId, file: stage.active.artifacts[stage.index]?.name, files: stage.active.artifacts.length, waiting: stage.queue.length || undefined }
    : view.display?.kind === 'images' ? { kind: 'pictures', of: short(view.display.query), count: view.display.images.length, enlarged: view.index ?? undefined }
    : view.display?.kind === 'email' ? { kind: 'email draft', to: view.display.to, subject: short(view.display.subject), state: view.status, note: short(view.note, 120) || undefined }
    : view.display?.kind === 'call' ? { kind: 'call', to: view.display.name || view.display.number, state: view.status }
    : selected ? { kind: 'details', of: short(selected.startsWith('artifact:') ? fileTitle(decodeURIComponent(selected.split(':').slice(2).join(':')).split('/').pop() ?? '') : selected, 60) } : null;
  const video = view.video && { title: short(view.video.alternates?.[view.videoIndex - 1]?.title || view.video.title || view.video.query), size: view.videoLarge ? 'large' : 'small',
    ...(view.videoIndex ? { skipped: view.videoIndex } : {}), ...(view.videoError ? { problem: view.videoError } : {}) };
  const pointer = usePointerStore.getState();
  const issue = view.issue && Date.now() - view.issue.at < 180_000 ? short(view.issue.text, 200) : undefined;
  return {
    open, ...(video ? { video } : {}),
    agents: agents.filter(agent => agent.codingAgent).map(agent => {
      const task = running(agent.id);
      return { id: agent.id, state: agent.status ?? 'idle', ...(task ? { doing: short(task.title), latest: short(latestStep(task.stdout), 60) || undefined } : {}) };
    }),
    queued: tasks.filter(task => task.status === 'queued').length || undefined,
    teams: swarms.filter(swarm => ['running', 'evaluating'].includes(swarm.status)).length || undefined,
    voice: useHud.getState().speaking ? 'speaking' : useHud.getState().voice,
    hands: pointer.status === 'tracking' ? pointer.mode : pointer.status,
    ...(pointer.error ? { cameraProblem: short(pointer.error, 120) } : {}),
    eyes: useAttention.getState().status,
    ...(issue ? { lastProblem: issue } : {}),
    window: `${innerWidth}x${innerHeight}`,
  };
}

/** `?see=tab` (remembered) asks the browser for a real picture of this tab. Off with `?see=off`. */
function seeMode(): 'tab' | 'sketch' | 'off' {
  try {
    const param = new URLSearchParams(location.search).get('see');
    if (param && ['tab', 'sketch', 'off'].includes(param)) localStorage.setItem('marbles.see', param);
    const stored = localStorage.getItem('marbles.see');
    return stored === 'tab' || stored === 'off' ? stored : 'sketch';
  } catch { return 'sketch'; }
}

let tab: { stream: MediaStream; video: HTMLVideoElement } | null = null;
/** Ask once, from the orb's click, to capture this tab. Declining simply falls back to the sketch. */
export async function enableTabCapture() {
  if (seeMode() !== 'tab' || tab || !navigator.mediaDevices?.getDisplayMedia) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions);
    const video = document.createElement('video');
    video.muted = true; video.srcObject = stream;
    await video.play();
    tab = { stream, video };
    stream.getVideoTracks()[0].onended = () => { tab = null; };
  } catch { /* declined: the sketch still works */ }
}
export function disableTabCapture() { tab?.stream.getTracks().forEach(track => track.stop()); tab = null; }

const WIDTH = 900;
/** A small JPEG of the interface: the real tab if capture is on, otherwise the
 * scene canvas with each open window drawn as a labelled outline. */
export function captureScreen(): string | null {
  if (seeMode() === 'off') return null;
  try {
    const canvas = document.createElement('canvas');
    const scale = WIDTH / innerWidth;
    canvas.width = WIDTH; canvas.height = Math.round(innerHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (tab && tab.video.videoWidth) ctx.drawImage(tab.video, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = '#060b14'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scene = document.querySelector<HTMLCanvasElement>('.stage canvas');
      if (scene) { const box = scene.getBoundingClientRect(); ctx.drawImage(scene, box.left * scale, box.top * scale, box.width * scale, box.height * scale); }
      ctx.font = '13px system-ui, sans-serif'; ctx.textBaseline = 'top';
      for (const element of document.querySelectorAll<HTMLElement>('[data-closable], .voice-subtitles .subtitle, .gesture-widget')) {
        const box = element.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) continue;
        const label = element.matches('[data-closable]') ? short(element.getAttribute('aria-label') || element.querySelector('h2, .nm')?.textContent || 'window', 80) : short(element.textContent ?? '', 90);
        if (element.matches('[data-closable]')) {
          ctx.fillStyle = 'rgba(16,32,52,.92)'; ctx.fillRect(box.left * scale, box.top * scale, box.width * scale, box.height * scale);
          ctx.strokeStyle = '#7fe3f5'; ctx.lineWidth = 1.5; ctx.strokeRect(box.left * scale, box.top * scale, box.width * scale, box.height * scale);
          const body = short(element.querySelector('.presentation-reader, .immersive-content, .video-window-note')?.textContent ?? '', 320);
          ctx.fillStyle = '#c9d8e6';
          body.match(/.{1,90}(\s|$)/g)?.slice(0, 5).forEach((line, n) => ctx.fillText(line.trim(), box.left * scale + 10, box.top * scale + 34 + n * 17));
        }
        ctx.fillStyle = '#ffffff'; ctx.fillText(label, box.left * scale + 10, box.top * scale + 10);
      }
    }
    return canvas.toDataURL('image/jpeg', .6);
  } catch { return null; }
}

/** Put the newest picture where the coordinator can ask for it. Local only, never awaited for long. */
export async function shareScreen() {
  const image = captureScreen();
  if (!image) return;
  try { await fetch('/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }), signal: AbortSignal.timeout(1200) }); }
  catch { /* the description still goes with the request */ }
}

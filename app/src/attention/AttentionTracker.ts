import { create } from 'zustand';
import { DEFAULT_ASSETS, GONE_MS, pointerTarget } from '../input';
import { AttentionFilter, closestFace, facing, poseFromMatrix, type Attention, type Face } from './headPose';
import type { LookObservation } from './LookToWake';

// Watches the camera for the nearest face and reports whether that person is
// looking at the screen. Everything runs on this device: frames go to a worker
// running MediaPipe's face landmarker and are never stored or sent anywhere.
//
// It is deliberately light: a small frame a few times a second is plenty to
// tell where a head is pointing, and the hand tracker needs the rest.
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const INTERVAL_MS = 260;
const BUSY_INTERVAL_MS = 800; // while a hand is working, the hand tracker gets the processor
const FRAME_WIDTH = 192;

export type AttentionStatus = 'off' | 'starting' | 'error' | Attention;
export const useAttention = create<{ status: AttentionStatus; error: string; observation: LookObservation | null }>(() => ({ status: 'off', error: '', observation: null }));

/** Turned off with `?attention=off` in the address, or localStorage `marbles.attention = "off"`. */
export function attentionEnabled() {
  try {
    const param = new URLSearchParams(location.search).get('attention');
    if (param) localStorage.setItem('marbles.attention', param === 'off' ? 'off' : 'on');
    return localStorage.getItem('marbles.attention') !== 'off';
  } catch { return true; }
}

type WorkerOut = { type: 'ready' } | { type: 'error'; message: string } | { type: 'faces'; faces: Face[] };

// Runs INSIDE the worker and must be self-contained: it is started from its own
// source text, the same way the hand tracker's worker is.
function faceWorkerMain() {
  const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null };
  let landmarker: { detectForVideo(frame: ImageBitmap, time: number): { faceLandmarks?: { x: number; y: number }[][]; facialTransformationMatrixes?: { data: number[] }[] } } | null = null;
  scope.onmessage = async ({ data }) => {
    if (data.type === 'init') {
      try {
        const load = new Function('u', 'return import(u)') as (url: string) => Promise<any>;
        const vision = await load(data.visionUrl);
        const fileset = await vision.FilesetResolver.forVisionTasks(data.wasmUrl);
        landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: data.modelUrl, delegate: 'CPU' }, runningMode: 'VIDEO',
          numFaces: 3, outputFacialTransformationMatrixes: true, outputFaceBlendshapes: false,
        });
        scope.postMessage({ type: 'ready' });
      } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    const bitmap: ImageBitmap = data.bitmap;
    try {
      if (!landmarker) return;
      const result = landmarker.detectForVideo(bitmap, data.time);
      const faces = (result.faceLandmarks ?? []).map((points, index) => {
        let left = 1, right = 0;
        for (const point of points) { if (point.x < left) left = point.x; if (point.x > right) right = point.x; }
        return { matrix: Array.from(result.facialTransformationMatrixes?.[index]?.data ?? []), size: right - left };
      }).filter(face => face.matrix.length === 16);
      scope.postMessage({ type: 'faces', faces });
    } catch { scope.postMessage({ type: 'faces', faces: [] }); }
    finally { bitmap.close(); }
  };
}

class AttentionTracker {
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private worker?: Worker;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private lastFrame = 0;
  private filter = new AttentionFilter();
  private generation = 0;

  async start() {
    if (!attentionEnabled() || this.stream || useAttention.getState().status === 'starting') return;
    const generation = ++this.generation;
    useAttention.setState({ status: 'starting', error: '', observation: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true; video.muted = true; video.srcObject = stream;
      video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(video);
      this.video = video;
      await video.play();
      if (generation !== this.generation) return;
      const url = URL.createObjectURL(new Blob([`(${faceWorkerMain.toString()})();`], { type: 'text/javascript' }));
      const worker = new Worker(url);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.worker = worker;
      worker.onerror = () => { if (generation === this.generation) this.fail('The face model could not start.'); };
      worker.onmessage = ({ data }: MessageEvent<WorkerOut>) => {
        if (generation !== this.generation) return;
        if (data.type === 'error') return this.fail(data.message);
        if (data.type === 'ready') { this.filter = new AttentionFilter(); useAttention.setState({ status: 'nobody' }); this.timer = setInterval(() => this.tick(), INTERVAL_MS); return; }
        this.busy = false;
        const nearest = closestFace(data.faces);
        const now = performance.now(), pose = nearest ? poseFromMatrix(nearest.matrix) : null;
        const status = this.filter.update(now, pose);
        // Startup uses raw observations so the indicator's look-away hysteresis
        // cannot turn a brief glance into a held look.
        useAttention.setState({ status, observation: { looking: !!pose && facing(pose), at: now } });
      };
      const abs = (value: string) => new URL(value, document.baseURI).href;
      worker.postMessage({ type: 'init', visionUrl: abs(DEFAULT_ASSETS.visionUrl), wasmUrl: abs(DEFAULT_ASSETS.wasmUrl), modelUrl: FACE_MODEL });
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : 'Camera unavailable.');
    }
  }
  private async tick() {
    const video = this.video;
    if (!video || !this.worker || this.busy || document.hidden || !video.videoWidth) return;
    // Face and hand models share the same cores. A hand in view means the user
    // is pointing or dragging, which must stay smooth; where their head points
    // changes slowly, so it can be checked far less often meanwhile.
    const now = performance.now();
    const handBusy = pointerTarget.present && now - pointerTarget.lastSeen < GONE_MS;
    if (handBusy && now - this.lastFrame < BUSY_INTERVAL_MS) return;
    this.lastFrame = now;
    this.busy = true;
    const generation = this.generation;
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: FRAME_WIDTH, resizeHeight: Math.round(FRAME_WIDTH * video.videoHeight / video.videoWidth) });
      if (generation !== this.generation || !this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, time: performance.now() }, [bitmap]);
    } catch { if (generation === this.generation) this.busy = false; }
  }
  private fail(message: string) {
    this.release();
    // Attention is an extra: without it the wake word works exactly as before.
    useAttention.setState({ status: 'error', error: message, observation: null });
  }
  private release() {
    clearInterval(this.timer); this.timer = undefined; this.busy = false;
    this.worker?.terminate(); this.worker = undefined;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    this.video?.remove(); this.video = undefined;
  }
  stop() {
    this.generation++;
    this.release();
    useAttention.setState({ status: 'off', error: '', observation: null });
  }
}

export const attentionTracker = new AttentionTracker();

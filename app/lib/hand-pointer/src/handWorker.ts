// Hand landmark inference, isolated on a worker thread. On a CPU delegate the
// model costs ~80ms/frame (measured), which would freeze rendering if run on the
// main thread. Here it blocks only the worker; the main thread keeps drawing the
// cursor at display rate from the last result. The main thread sends frames as
// transferable ImageBitmaps and only when the worker is idle (backpressure), so
// the freshest frame is always processed, never a backlog.
//
// How the worker is made: handWorkerMain below is turned into source text with
// toString() and started from a Blob. That keeps the library free of bundler
// requirements (no worker plugin, no asset URL for a consumer to configure) and
// gives a CLASSIC worker, which MediaPipe needs: its wasm glue loads itself with
// importScripts(), which a module worker forbids.
//
// The price is one rule: handWorkerMain must be self-contained. It may not
// reference anything outside its own body (no imports, no module constants, no
// helpers), because none of that exists in the worker. Types are fine, they are
// erased. Everything it needs at runtime arrives in the init message.

// One detected hand: index fingertip (8) in normalized frame coords, thumb tip
// (4) for the pinch gesture, and which hand it is so the main thread can pick
// the one the user nominated as primary.
export type HandOut = {
  x: number;
  y: number;
  thumbX: number;
  thumbY: number;
  conf: number;
  hand: "L" | "R";
  // All 21 landmarks, flat [x0,y0,x1,y1,...] in normalized frame coords, for
  // overlays and recordings. Always sent: 42 numbers alongside an ~80ms
  // inference is not worth a second message type and a flag to switch off.
  pts: number[];
};

// Where the worker fetches MediaPipe from. Absolute URLs (a Blob worker has no
// base to resolve a relative one against; see resolveAssets in cameraPointer).
export interface HandAssets {
  visionUrl: string; // the tasks-vision ESM bundle
  wasmUrl: string; // folder holding the wasm files
  modelUrl: string; // hand_landmarker.task
}

export type WorkerIn =
  | { type: "init"; assets: HandAssets; trace: boolean }
  | { type: "frame"; bitmap: ImageBitmap; t: number };

export type WorkerOut =
  | { type: "ready" }
  | { type: "error"; message: string }
  // Every hand seen this frame; empty array when none were found.
  | { type: "hands"; hands: HandOut[]; t: number };

// The slice of MediaPipe this file uses, declared locally so the library needs
// no type dependency on @mediapipe/tasks-vision.
interface Landmarker {
  detectForVideo(
    image: ImageBitmap,
    timestampMs: number,
  ): {
    landmarks?: { x: number; y: number }[][];
    handednesses?: { categoryName: string; score: number }[][];
  };
}
interface VisionModule {
  FilesetResolver: { forVisionTasks(wasmUrl: string): Promise<unknown> };
  HandLandmarker: { createFromOptions(fileset: unknown, options: object): Promise<Landmarker> };
}

// Runs INSIDE the worker. Self-contained: see the rule at the top of the file.
export function handWorkerMain() {
  const scope = self as unknown as {
    postMessage(m: WorkerOut): void;
    onmessage: ((ev: MessageEvent<WorkerIn>) => void) | null;
  };

  // Whether MediaPipe's handedness labels need flipping to match the user's
  // real hands. Verified against an actual hand on 2026-08-25: they do NOT,
  // despite the raw (unmirrored) frame we feed it, so this stays false. Kept as
  // a named constant because it is the single thing to flip if the L/R control
  // ever selects the wrong hand on another camera or MediaPipe version.
  const HANDEDNESS_MIRRORED = false;

  let landmarker: Landmarker | null = null;
  let trace = false;
  let frameNo = 0;

  async function init(assets: HandAssets) {
    try {
      // Built at runtime so no bundler sees (and rewrites) the dynamic import:
      // a dev server would otherwise wrap it in a helper that does not exist in
      // here. A dynamic import() of an absolute URL is allowed in a classic
      // worker.
      const load = new Function("u", "return import(u)") as (u: string) => Promise<VisionModule>;
      const vision = await load(assets.visionUrl);
      const fileset = await vision.FilesetResolver.forVisionTasks(assets.wasmUrl);
      landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: assets.modelUrl, delegate: "CPU" },
        runningMode: "VIDEO",
        // Both hands: the primary one drives the cursor, the other enables
        // two-handed gestures. Costs real inference time on the CPU delegate.
        numHands: 2,
      });
      scope.postMessage({ type: "ready" });
    } catch (e) {
      scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  scope.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === "init") {
      trace = msg.trace;
      void init(msg.assets);
      return;
    }
    if (msg.type === "frame") {
      const { bitmap, t } = msg;
      if (!landmarker) {
        bitmap.close();
        return;
      }
      frameNo++;
      const log = trace && frameNo <= 3; // timing for the first few frames only
      try {
        if (log) console.log(`[worker] detect ${frameNo} start (bitmap ${bitmap.width}x${bitmap.height})`);
        const t0 = performance.now();
        const res = landmarker.detectForVideo(bitmap, t);
        const all = res.landmarks ?? [];
        if (log)
          console.log(`[worker] detect ${frameNo} end ${(performance.now() - t0).toFixed(0)}ms hands=${all.length}`);
        const hands: HandOut[] = [];
        for (let i = 0; i < all.length; i++) {
          const lm = all[i];
          if (!lm) continue;
          const cat = res.handednesses?.[i]?.[0];
          const raw: "L" | "R" = cat?.categoryName === "Left" ? "L" : "R";
          const hand = HANDEDNESS_MIRRORED ? (raw === "L" ? "R" : "L") : raw;
          const pts: number[] = [];
          for (const p of lm) pts.push(p.x, p.y);
          hands.push({
            x: lm[8].x,
            y: lm[8].y,
            thumbX: lm[4].x,
            thumbY: lm[4].y,
            conf: cat?.score ?? 1,
            hand,
            pts,
          });
        }
        scope.postMessage({ type: "hands", hands, t });
      } catch (e) {
        // Post an empty result anyway so the main thread frees its backpressure
        // flag and the pump keeps going; report the cause once.
        scope.postMessage({ type: "hands", hands: [], t });
        scope.postMessage({
          type: "error",
          message: "detectForVideo: " + (e instanceof Error ? e.message : String(e)),
        });
      } finally {
        bitmap.close();
      }
    }
  };
}

// Start the worker from handWorkerMain's own source. The Blob URL is released
// once the worker has loaded it.
export function createHandWorker(): Worker {
  const source = `(${handWorkerMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return worker;
}

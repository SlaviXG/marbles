# hand-pointer

Working name. Webcam hand tracking as a pointer for any web page.

Raise a hand and a cursor follows your index fingertip. Pinch thumb and index to
press. The page receives ordinary DOM pointer events, so existing click, hover
and drag handlers work unchanged. No dependencies, no bundler setup.

## Gestures

| Gesture | Result |
| --- | --- |
| Move hand | `pointermove`, `pointerover`, `pointerout` |
| Pinch and release | `pointerdown`, `pointerup`, `click` |
| Pinch, move, release | A drag |
| Pinch with both hands, change separation | `zoom` action |
| Pinch with both hands, move together | `pan` action |
| Move the real mouse | Mouse takes the cursor back. A deliberate hand move reclaims it |

## Quick start

```ts
import { startHandPointer } from "hand-pointer";

const stop = await startHandPointer(); // asks for the camera, shows the dot
// later
stop();
```

Zoom and pan are semantic actions, not pointer events. Claim them where it makes
sense:

```ts
import { registerActionHandler } from "hand-pointer";

const off = registerActionHandler((a) => {
  if (a.type === "zoom") zoomBy(a.delta, a.x, a.y);
  else if (a.type === "pan") panBy(a.dx, a.dy);
  else return false;
  return true; // claimed
});
```

Handlers run highest priority first and the first to return `true` wins, so an
overlay can outrank the canvas behind it (`PRIORITY.overlay`, `PRIORITY.world`).

## Status

```ts
import { pointerStore } from "hand-pointer";

pointerStore.subscribe(() => {
  const { status, mode, error } = pointerStore.getState();
  // status: off | starting | tracking | denied | error
  // mode: hand | mouse (who owns the cursor)
});
```

The store has the `getState` / `subscribe` shape that React's
`useSyncExternalStore` takes directly.

## Running offline

MediaPipe's runtime and model load from public CDNs by default. To serve them
yourself (recommended on unreliable networks), copy the files into your app and
pass their URLs:

```ts
await startHandPointer({
  assets: {
    visionUrl: "/mediapipe/vision_bundle.mjs",
    wasmUrl: "/mediapipe/wasm",
    modelUrl: "/mediapipe/hand_landmarker.task",
  },
});
```

The first two come from the `@mediapipe/tasks-vision` npm package (version
0.10.14), the model from the URL in `DEFAULT_ASSETS`.

## Building your own cursor

`startHandPointer` composes four public pieces. Wire them yourself for a custom
cursor element, your own frame loop, or a different event sink.

| Piece | Role |
| --- | --- |
| `cameraPointer` | Camera and worker session. Fills `pointerTarget` and `secondaryHand` (screen px, pinch state) |
| `CursorDriver` | Hand state in, cursor frame out. Recognises press, drag, zoom, pan. No DOM, no clock |
| `VirtualPointer` | Turns the driver's pointer effects into synthetic DOM events |
| `dispatchAction` | Routes zoom and pan to the registered handlers |

```ts
const driver = new CursorDriver({ sink: new VirtualPointer(), emit: dispatchAction }, performance.now());

function frame(now: number) {
  const handMode = pointerStore.getState().mode === "hand";
  const f = driver.step(now, pointerTarget, secondaryHand, handMode);
  // draw f.x, f.y, f.opacity, f.pressing however you like
  requestAnimationFrame(frame);
}
```

Because the driver takes time and hand state as arguments, a recorded session
can be replayed through it with different `CursorParams` and no camera.

Optional: `setMagnetProvider` lets the app expose a field of targets (id,
centre, radii) that the cursor eases onto, which makes small targets reachable
with a shaky hand.

## Tuning

| Object | Covers |
| --- | --- |
| `PointerParams` (`loadParams`, `saveParams`) | Jitter filter, active zone of the camera frame, deadzone, inference rate, pinch thresholds |
| `CursorParams` (`DEFAULT_CURSOR_PARAMS`) | Cursor smoothing, pinch anchor, magnet feel, zoom gain |

Add `?debug` to the page URL for a per-second pipeline heartbeat in the console.

## Limits

- Inference runs on the CPU in a worker, about 12 to 15 fps. The cursor is
  interpolated to display rate.
- Synthetic events are not trusted events. Browser features that require a real
  user gesture (fullscreen, clipboard, cross-origin iframes) will not respond.
- Needs a secure context (https or localhost) for camera access.
- Tested in Chrome. The build output targets bundlers (Vite, webpack, esbuild).

## Develop

```sh
npm install
npm run demo   # demo page
npm test
npm run build  # dist/
```

## Licence

Not yet chosen.

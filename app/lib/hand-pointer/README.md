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

A hand only counts while it is held up with its palm toward the camera. See
[Which hands count](#which-hands-count).

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
| `PointerParams` (`loadParams`, `saveParams`) | Jitter filter, active zone of the camera frame, deadzone, inference rate, pinch thresholds, pose gate on or off (`requirePalm`) |
| `CursorParams` (`DEFAULT_CURSOR_PARAMS`) | Cursor smoothing, pinch anchor, magnet feel, zoom gain |

| Constants in `src/palm.ts` | Pose gate thresholds (see below) |

Add `?debug` to the page URL for a per-second pipeline heartbeat in the console.

## Which hands count

A hand seen in a bad pose produces pinches nobody meant, so the library ignores
it before reading any gesture. An ignored hand is treated as not in frame: no
cursor, no press, no two-hand zoom. Three measurements decide, all taken from
the wrist and knuckle landmarks, which do not move when the fingers bend.

| Measurement | Meaning | Typical values | Rejects |
| --- | --- | --- | --- |
| `palm` | Which side of the hand shows, and how square-on it is | About 0.6 or more for a flat palm, the same negative for the back, 0 edge-on | Back of the hand, hand turned sideways |
| `up` | Cosine of the angle between the wrist-to-knuckle line and straight up | 1 fingers up, 0 lying level, negative hanging down | Wrist level with or above the knuckles |
| `len` | Palm length (wrist to middle knuckle) divided by width across the knuckles | About 1.4 for a flat hand, falling to 0 as the fingers point at the lens | Hand tipped forward toward the camera |

Each measurement has two thresholds. A hand must be above every `ON` value to
start counting, and keeps counting until one measurement falls below its `OFF`
value. The gap stops a hand held near a limit from flickering in and out.

| Constant | Default | Roughly corresponds to |
| --- | --- | --- |
| `PALM_ON` / `PALM_OFF` | 0.4 / 0.3 | Turned 55 / 65 degrees away from facing the camera |
| `UP_ON` / `UP_OFF` | 0.5 / 0.35 | Fingers 60 / 70 degrees from straight up |
| `LEN_ON` / `LEN_OFF` | 0.9 / 0.75 | Tipped 50 / 58 degrees toward the camera |

Set `requirePalm: false` in `PointerParams` to switch the gate off and accept a
hand in any pose.

### Estimating the thresholds

The defaults were worked out from hand proportions, not measured on a camera.
The angles in the table assume a flat hand reads `palm` 0.6 and `len` 1.4; if
your hand and camera read differently, the same thresholds cut in at different
angles. Measure before trusting them.

**1. See the numbers.** `handDebug.hands` holds, for every hand in frame, its
`pose` (`palm`, `up`, `len`) and whether it is `active`. In the marbles app the
skeleton button draws them: a second row per hand shows the three values, with
the one keeping the hand out in red.

**2. Record three poses per measurement.** Hold each for a couple of seconds
and note the value, for both hands and at your usual distance.

| Pose | What to note |
| --- | --- |
| Flat, upright, square to the camera | The baseline for `palm` and `len` |
| Your normal pointing and pinching pose, including the most relaxed version you would still expect to work | The lowest value that must still count |
| The pose where gestures start to misfire (turn, lower or tip the hand until pinches trigger by accident or the skeleton jumps) | The highest value that must be rejected |

**3. Place the thresholds between the last two.** Put `OFF` just above the
misfire value and `ON` above that, with both below the lowest value from normal
use. Keep a gap of at least 0.1 between `ON` and `OFF` (0.15 for `len`, which
has a wider range), or the hand will flicker at the limit.

If normal use and misfires overlap, the measurement cannot separate them on its
own. Prefer rejecting: a hand that must be straightened slightly is a smaller
problem than an accidental click.

**4. Or work from an angle.** A limit in degrees converts to a threshold once
you know the flat value:

| Measurement | Threshold for a limit angle |
| --- | --- |
| `up` | `cos(angle)` |
| `len` | `flat × cos(angle)` |
| `palm` | `sin(atan(tan(asin(flat)) × cos(angle)))` |

For example, with a measured flat `len` of 1.5, rejecting hands tipped more
than 45 degrees means `LEN_OFF = 1.5 × cos(45°) ≈ 1.06`. `palm` is the sine of
an angle on the palm rather than a length, so it falls more slowly than a plain
cosine: with a flat value of 0.6, a 60 degree turn reads about 0.35, not 0.3.

**5. Check the sign.** If a palm reads negative and the back positive, the
left and right labels from the tracker are swapped for your setup. Flip
`RIGHT_PALM_SIGN` in `src/palm.ts`.

Known weak spots:

- Pointing at the screen tips the hand forward, which lowers `len`. This is the
  threshold most likely to need loosening.
- `len` rises when the hand turns sideways (the width shrinks), so it is only
  meaningful while `palm` passes.
- The values depend on the tracker's landmarks, which get noisy at the edges of
  the frame and in poor light. Measure where you will actually use it.

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

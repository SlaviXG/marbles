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
| Raise both hands, move one | The moving hand takes the cursor (see [Which hand drives](#which-hand-drives)) |
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
| `PointerParams` (`loadParams`, `saveParams`) | Jitter filter, active zone of the camera frame, deadzone, inference rate, pinch thresholds, fast-motion pinch guard (`pinchMaxSpeed`), pose gate on or off (`requirePalm`), automatic hand choice (`autoHand`) |
| `CursorParams` (`DEFAULT_CURSOR_PARAMS`) | Cursor smoothing, pinch anchor, press hold, magnet feel, zoom gain |

| Constants in `src/palm.ts` | Pose gate thresholds (see below) |
| Constants in `src/handArbiter.ts` | When the cursor changes hands (see below) |

Add `?debug` to the page URL for a per-second pipeline heartbeat in the console.
The same flag turns on the recorder: every result frame is kept in memory,
`m` marks a moment, `Shift+D` downloads the recording as JSON and `Shift+C`
clears it. Every threshold in this library was first set by estimate, and a
recording is how to set them from your own camera instead. See
[RECORDING.md](RECORDING.md) for the takes to record and
`tools/analyzeRecording.mjs` for the numbers it produces.

## Keeping the cursor still through a pinch

Closing a pinch pulls the index fingertip down toward the thumb, and the whole
hand tends to sink a little with it. If the cursor simply followed the
fingertip, a click would start where you aimed, slide while the pinch was
held, and release somewhere else. Three things prevent that:

| Mechanism | Where | What it does |
| --- | --- | --- |
| Aim point | `src/aimPoint.ts` | The cursor aims from the index knuckle plus a remembered knuckle-to-fingertip offset. The offset follows the finger while the hand is open and is frozen while the fingers close or are pinched, so the curl of the finger never reaches the cursor. The knuckle still carries the hand's own movement |
| Press hold | `pressHoldPx` in `CursorParams` | Once pressed, the dot stays exactly at the press point until the hand has travelled 18 px. Past that it is a drag and the dot follows, without a jump |
| Pinch anchor | `pinchAnchor*` in `CursorParams` | At the instant of the press, places it where the dot was 100 ms earlier |

With the hand open, the aim point is the fingertip, so pointing and reach are
unchanged. The one difference is that aiming by moving the finger alone,
without the hand, follows with a short ease (`aimTau`).

| Param (`PointerParams`) | Default | Meaning |
| --- | --- | --- |
| `aimTau` | 0.15 s | How quickly the offset follows the finger while open. 0 turns the aim point off (raw fingertip) |
| `aimFreezeDist` | 0.09 | Freeze while the thumb-index gap is below this |
| `aimFreezeRate` | 0.25 /s | Freeze while the gap is closing faster than this |
| `aimHoldMs` | 150 | Stay frozen this long after the last reason to freeze |

These defaults come from a simulated pinch, not camera measurements. To tune:

- **The cursor still dips when you pinch:** raise `aimFreezeDist` (freeze
  earlier), or raise `pressHoldPx` if it is the whole hand that sinks.
- **The cursor ignores your finger while pointing:** your open thumb-index gap
  is below `aimFreezeDist`, so the offset never updates. Read `pin` in the
  skeleton view while pointing and set `aimFreezeDist` below that value, but
  above `pinchOff`.
- **Short drags feel stuck at the start:** lower `pressHoldPx`.

## False pinches during fast movement

A hand sweeping quickly through the frame is blurred by the camera, and the
tracker's thumb and index tips smear together for a frame or two. That reads
as a quick pinch and fires a click nobody made, most often on fast vertical
moves.

The library refuses a pinch that starts while the palm is moving faster than
`pinchMaxSpeed` (default 1.5 frame heights per second), and for `PINCH_SETTLE`
(0.12 s) after it slows. What is not affected:

- A pinch already held. Drags can be as fast as you like and release normally.
- A click made at pointing speed. Only onset during fast travel is refused.

Speed is read from the middle knuckle, which survives blur and does not move
when the fingers close.

The default is an estimate. `handDebug.fast` says per hand whether the guard is
active (`pin fast` in red in the marbles skeleton view). If false pinches
still get through on sweeps, lower `pinchMaxSpeed`; if `pin fast` shows while
you are trying to click, raise it. `pinchMaxSpeed: 0` turns the guard off.

## Which hand drives

With one hand in frame, that hand drives the cursor. With both, the cursor
follows the hand that is moving while the other is at rest, and stays with it
until the roles clearly reverse. There is nothing to select: either hand can
take the cursor at any time by moving while the other rests.

The code is in `src/handArbiter.ts`: `MotionTracker` measures each hand,
`HandArbiter` decides, `PinchLatch` and `HandoffOffset` deal with the moment
of the handover. `cameraPointer` wires them together.

### When the cursor changes hands

A wrong switch is worse than a late one, so the rules lean toward staying put.
With both hands in frame, on every inference result:

1. The other hand's motion must exceed `MOVE`, and must also exceed the
   driving hand's motion divided by `REST_RATIO`. In words: the other hand is
   moving, and the driving hand is moving less than 0.6 times as much. Two
   hands moving alike, or two still hands, change nothing.
2. While that holds, evidence builds up. It is measured in seconds, weighted
   by how far past the bar the other hand is: clearing the bar by `MOVE`
   earns one second per second, more earns faster (up to `GAIN_MAX` times),
   less earns slower.
3. While it does not hold, the evidence drains at `LEAK` seconds per second.
   It is not thrown away, so one bad frame in the middle of a clear move costs
   two frames, not the whole wait.
4. The cursor changes hands once the evidence reaches `EVIDENCE` and the
   condition has held on `MIN_FRAMES` consecutive results. No single result
   can do it, however large the move.

What that means in practice, at about 13 to 15 results per second:

| Move by the other hand, driving hand at rest | Handover after |
| --- | --- |
| Clear (motion 0.36 palm lengths or more) | 2 results, about 0.15 s |
| Marginal (1.3 x `MOVE`) | 4 to 5 results, about 0.3 to 0.4 s |
| Below `MOVE` | Never |

If the driving hand had been moving just before, add the time its own motion
takes to fall away, a few tenths of a second (see
[How movement is measured](#how-movement-is-measured)).

Only hands that pass the pose gate take part (see
[Which hands count](#which-hands-count)). A badly turned hand counts as not in
frame.

### What stops a handover

- **Pinch.** Nothing switches while the driving hand is pinching, so a click,
  drag or two-hand zoom is never interrupted. A pinch on the other hand does
  not block it: a relaxed hand often rests with thumb and finger close enough
  to read as one.
- **Grace period.** If the driving hand is missing from a result while the
  other is visible, it keeps the cursor for `DRIVER_GRACE` (0.25 s, about
  three results). Single misses are common and are not the user changing
  hands: a pinched hand hides its own landmarks, the pose gate flickers at
  its limit, the tracker swaps its left and right labels for a frame. During
  the grace the cursor stays exactly where it is. If the hand is still
  missing after that, the visible hand takes over. If the missing hand was
  pinching, the other hand never takes over under the pinch; the pinch is
  released after `GONE_MS` (250 ms) unseen, as it is with no hand in frame,
  and the visible hand takes over on the next result.
- **Refractory period.** For `REFRACTORY` (0.6 s) after a handover, the other
  hand's motion must exceed twice `MOVE` instead of `MOVE`. The hand that just
  gave up the cursor is often still settling, and this stops the cursor
  flipping straight back. A deliberate move back is well above the doubled
  bar and is not delayed.
- **Glitch guard.** The tracker sometimes puts a hand somewhere else for one
  result and then back. If a hand's step nearly cancels the one before it
  (their sum is under half the larger) and both steps are over 0.15 palm
  lengths, that result is treated as a glitch: the evidence is zeroed, and
  the reference position (below) is put back where it was before the jump, so
  the jump leaves no motion behind. Together with `MIN_FRAMES` this means a
  one-result jump of any size cannot move the cursor to the other hand. A
  glitch that lasts two or more results is not caught.

### What happens to the cursor

The cursor does not jump at a handover. The new hand picks it up from where it
stands, and the gap between the cursor and that hand's own position drains
away as the hand travels (0.4 px per px moved, `offsetRecycle` in
`CursorParams`), so it blends back to pointing directly. A still hand holds
the cursor exactly in place.

### The pinch latch

Pinch state belongs to the physical hand, not to whichever hand is driving.
When a hand takes the cursor over, its pinch is not passed on as a press until
its thumb-index gap has been seen at or above `pinchOff`, that is, until the
hand has been seen open. Without this, a resting hand with thumb and finger
close together would click, or start a drag, on the very frame it took over.

The cost: a hand that takes over half-closed has to open before its first
click. If a click right after a handover does nothing, watch `pin` for that
hand in the skeleton view; it has to rise above `pinchOff` once.

The two-hand zoom is unaffected in steady use: it needs both hands pinched,
each hand's own pinch is tracked separately, and no handover happens during
it because the driving hand is pinching.

### How movement is measured

Each hand has a reference position that follows it with a time constant of
`MOTION_TAU` (0.2 s): a lagged copy of where the hand has been. Motion is the
distance between the hand and its reference.

- A hand moving at a steady speed runs ahead of its reference by about
  `speed x 0.24 s`. A hand crossing one palm length per second reads about
  0.24.
- A hand that stops is caught up by its reference: the reading falls by about
  a third per result and is under `MOVE` within a few tenths of a second.
- A hand that only jitters stays on top of its reference and reads a few
  hundredths.

The position used is the index knuckle (landmark 5), not the fingertip, so a
resting hand that pinches does not read as moving.

The unit is palm lengths: the distance is divided by the wrist to middle
knuckle length in the image (smoothed over 0.5 s). The same gesture covers
fewer frame heights the further the hand is from the camera, and dividing by
the palm cancels that, so the constants below do not depend on how far away
you sit.

The reading uses the real time between results, so it changes by under 10%
between 60 ms and 100 ms intervals and a late result does not zero it. After a
gap longer than `MAX_GAP` (0.5 s) the tracker starts again from zero: arriving
is not a move.

### Constants

All in `src/handArbiter.ts`.

| Constant | Default | Meaning |
| --- | --- | --- |
| `MOVE` | 0.12 palm lengths | Least motion that counts as pointing |
| `REST_RATIO` | 0.6 | The driving hand counts as resting while its motion is below this fraction of the other hand's |
| `EVIDENCE` | 0.08 s | Evidence needed for a handover |
| `GAIN_MAX` | 2 | Fastest rate evidence can build, in seconds per second |
| `LEAK` | 1 /s | Rate evidence drains while the condition fails |
| `MIN_FRAMES` | 2 | Consecutive results the condition must hold on |
| `REFRACTORY` | 0.6 s | How long after a handover the bar is doubled |
| `DRIVER_GRACE` | 0.25 s | How long a missing driving hand keeps the cursor |
| `MOTION_TAU` | 0.2 s | Lag of the reference position |
| `MAX_GAP` | 0.5 s | A gap between results longer than this restarts the motion reading |

**These values come from simulation with assumed tracker jitter, not from
camera measurements.** The assumption is Gaussian jitter of 0.004 frame
heights per axis on the knuckle, for a palm 0.12 frame heights long (about 3%
of the palm). Under it, two still hands produced no handover in 200 simulated
minutes. The margin is not large: at 0.006 the same simulation gave 6 false
handovers in 200 minutes, and at 0.008 more than one a minute. If your camera
is noisier than assumed, `MOVE` is the first thing to raise. Measure before
trusting the defaults: hold both hands still and read `mov`.

### Tuning the handover

`handDebug.motion` holds the live motion per hand (`mov` in the marbles
skeleton view, gold above `MOVE`). `handDebug.arbiter` says what the arbiter
is doing and `handDebug.evidence` how far along a handover is, from 0 to 1
(shown together as `swap:`, for example `swap: evidence 60%`).

| `swap:` | Meaning | If it is the one in the way |
| --- | --- | --- |
| `other still` | The other hand's motion is below the bar (`MOVE`, or twice that just after a handover) | Lower `MOVE`; if it only happens right after a handover, lower `REFRACTORY` |
| `driver moving` | The other hand is over the bar, but the driving hand is not resting by comparison | Raise `REST_RATIO`, or lower `MOTION_TAU` if it clears a moment after the driving hand stops |
| `pinch` | The driving hand reads as pinching | Check `pinchOn` / `pinchOff`; a relaxed hand may be reading as a pinch |
| `glitch` | The other hand's last step undid the one before; evidence was zeroed | Usually correct. If it shows during deliberate moves, the tracker is unstable; improve the light before changing anything |
| `evidence` | The condition holds and evidence is building | Lower `EVIDENCE` or raise `GAIN_MAX` to make it faster |
| `grace` | The driving hand is missing and is being waited for | If the driving hand is drawn red it is failing the pose gate; otherwise lower `DRIVER_GRACE` |
| `switched` | The cursor changed hands on this result | |

A percentage after `other still` or `driver moving` is evidence left over from
earlier results, draining.

If the hand trying to take over is drawn red, it is failing the pose gate and
is not taking part at all.

| Symptom | Change |
| --- | --- |
| Cursor changes hands while both hands are still | Raise `MOVE`. Check `mov` on the still hands first: it should stay well under `MOVE` |
| Cursor changes hands when the resting hand shifts a little | Raise `MOVE` or `EVIDENCE` |
| Cursor changes hands while you point with one hand and the other also moves | Lower `REST_RATIO` |
| Cursor flips back right after a handover | Raise `REFRACTORY` |
| Handover never happens; `swap:` stays on `other still` | Lower `MOVE` |
| Handover never happens; `swap:` stays on `driver moving` | Raise `REST_RATIO` |
| Handover is slow for a clear move | Lower `EVIDENCE`. It cannot go below `MIN_FRAMES` results |
| Handover is slow just after the first hand stops | Lower `MOTION_TAU` (this also lowers every motion reading, so lower `MOVE` in proportion) |
| Cursor freezes for a moment, then moves to the other hand, when one hand leaves | That is `DRIVER_GRACE`. Lower it, at the cost of handovers on missed detections |
| Cursor moves to the other hand when the driving hand is lost for a moment | Raise `DRIVER_GRACE`; check the pose gate is not flickering on the driving hand (drawn red) |
| First click after a handover does nothing | The pinch latch: that hand has not opened past `pinchOff` yet |
| Cursor drifts after a handover | Lower `offsetRecycle` |

`DRIVER_GRACE` is deliberately the same as `GONE_MS`, the time after which a
cursor with no hand is hidden. If you raise `DRIVER_GRACE` above it, a
pinching hand that goes missing still releases its press at `GONE_MS`, and
the cursor is then hidden until the grace is up and the other hand takes
over.

### Switching it off

`autoHand: false` in `PointerParams` disables all of this, including the
grace period: the hand set with `pointerStore.setPriority("L" | "R")` (default
right) then always drives when both are visible, and whichever hand is visible
drives when only one is. The pinch latch still applies whenever the cursor
changes hands. With `autoHand` on, that setting only decides which hand starts
with the cursor when both appear in the same frame, and changing it moves the
cursor to that hand at once (unless the driving hand is pinching).

## Which hands count

A hand seen in a bad pose produces pinches nobody meant, so the library ignores
it before reading any gesture. An ignored hand is treated as not in frame: no
cursor, no press, no two-hand zoom. Two measurements decide, taken from the
wrist, the knuckles and the finger middle joints. A third, `len`, is reported
but no longer decides anything.

| Measurement | Meaning | Typical values | Rejects |
| --- | --- | --- | --- |
| `palm` | Which side of the hand shows, and how square-on it is | About 0.6 or more for a flat palm, the same negative for the back, 0 edge-on | Back of the hand, hand turned sideways |
| `up` | How far the highest finger middle joint (landmarks 6, 10, 14, 18) sits above the wrist, in knuckle widths | Above 1 fingers up, positive lying sideways or pointing at the camera, negative once all four are below the wrist | Hand turned down: all four finger middle joints below the wrist |
| `len` | Palm length (wrist to middle knuckle) divided by width across the knuckles | About 1.4 for a flat hand, falling to 0 as the fingers point at the lens | Nothing; shown for information |

A hand tipped toward the camera, so the fingers nearly point at the lens, is
accepted as long as its fingers are above the wrist. That is how an ordinary
hand looks to a camera below it, and how many people point. Its palm looks
squashed in that pose, which would read as edge-on, so `palm` first stretches
the palm back to a flat hand's proportions along its length (never across it,
so a hand turned sideways is still caught). The back of the hand is still
rejected in that pose.

Each measurement has two thresholds. A hand must be above every `ON` value to
start counting, and keeps counting until one measurement falls below its `OFF`
value. The gap stops a hand held near a limit from flickering in and out.

| Constant | Default | Roughly corresponds to |
| --- | --- | --- |
| `PALM_ON` / `PALM_OFF` | 0.4 / 0.3 | Turned 55 / 65 degrees away from facing the camera |
| `UP_ON` / `UP_OFF` | 0.1 / 0 | Highest finger middle joint 0.1 knuckle widths above the wrist / all four below it |

Set `requirePalm: false` in `PointerParams` to switch the gate off and accept a
hand in any pose.

### Estimating the thresholds

The defaults were worked out from hand proportions, not measured on a camera.
The angles in the table assume a flat hand reads `palm` 0.6; if
your hand and camera read differently, the same thresholds cut in at different
angles. Measure before trusting them.

**1. See the numbers.** `handDebug.hands` holds, for every hand in frame, its
`pose` (`palm`, `up`, `len`) and whether it is `active`. In the marbles app the
skeleton button draws them: a second row per hand shows the three values, with
the one keeping the hand out in red (`len` is never red).

**2. Record three poses per measurement.** Hold each for a couple of seconds
and note the value, for both hands and at your usual distance.

| Pose | What to note |
| --- | --- |
| Flat, upright, square to the camera | The baseline for `palm` |
| Your normal pointing and pinching pose, including the most relaxed version you would still expect to work | The lowest value that must still count |
| The pose where gestures start to misfire (turn, lower or tip the hand until pinches trigger by accident or the skeleton jumps) | The highest value that must be rejected |

**3. Place the thresholds between the last two.** Put `OFF` just above the
misfire value and `ON` above that, with both below the lowest value from normal
use. Keep a gap of at least 0.1 between `ON` and `OFF`, or the hand will
flicker at the limit.

If normal use and misfires overlap, the measurement cannot separate them on its
own. Prefer rejecting: a hand that must be straightened slightly is a smaller
problem than an accidental click.

**4. Or work from an angle.** A limit in degrees converts to a threshold once
you know the flat value:

| Measurement | Threshold for a limit angle |
| --- | --- |
| `palm` | `sin(atan(tan(asin(flat)) × cos(angle)))` |

`palm` is the sine of an angle on the palm rather than a length, so it falls
more slowly than a plain cosine: with a flat value of 0.6, a 60 degree turn
reads about 0.35, not 0.3.

`up` is not an angle: it only asks whether the fingers are above the wrist. It
was an angle once, but seen from a camera below the hand an upright hand is
foreshortened and read as lying level, so it was rejected while held normally.

**5. Check the sign.** If a palm reads negative and the back positive, the
left and right labels from the tracker are swapped for your setup. Flip
`RIGHT_PALM_SIGN` in `src/palm.ts`.

Known weak spots:

- With the fingers pointing almost straight at the camera (past about 80
  degrees of tilt) the palm has collapsed to a line in the image and `palm`
  can no longer read it, so the hand drops out. Below that it is kept.
- Pinch detection is less reliable on a hand pointing at the camera, because
  the thumb and index tips overlap in the image. That is now allowed through,
  so watch for misfires in that pose.
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

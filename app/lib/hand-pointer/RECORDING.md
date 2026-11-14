# Recording hand data

The gesture thresholds in this library (how still is "still", how close is a
pinch, how fast is too fast) were chosen by estimate. The recorder captures
what the camera tracker actually reports for your hands, frame by frame, so
those numbers can be set from measurements. It records landmarks and the
library's decisions only. No video or image is stored.

A session takes about ten minutes: eight short takes, each saved as a JSON
file, then one script that prints the measurements.

## Start

1. In `app/`, run `npm run client` (or `npm run dev` for the full app).
2. Open `http://localhost:5173/?debug`. The `?debug` is what switches the
   recorder on; without it nothing is recorded and nothing below works.
3. Turn the hand cursor on with the "hand cursor" button and allow the camera.
   Recording starts by itself as soon as tracking does.

To check it is running, press `m`: a small black note saying `mark m1`
appears at the bottom of the screen for about a second.

## Keys

| Key | What it does |
| --- | --- |
| `m` | Drops a mark at this moment (`m1`, `m2`, ...). Use it to say "now". |
| `Shift` + `C` | Clears the recording. Press it at the start of every take. |
| `Shift` + `D` | Downloads the recording as `hand-recording-<date>-<time>.json`. |

The keys do nothing while you are typing in a text field, or with Ctrl, Alt
or Cmd held. Downloading does not clear, so press `Shift` + `C` before the
next take.

The same things are available in the browser console as `__handRec`:

```js
__handRec.mark("label")      // a mark with your own label
__handRec.clear()
__handRec.download("take3")  // saves take3.json
__handRec.summary()          // quick numbers, see below
__handRec.rows               // the rows recorded so far
__handRec.marks
```

Turning the hand cursor off removes `__handRec` and the keys, but keeps what
was recorded: turn it back on and the recording carries on. Reloading the page
does discard it, so download before you reload.

## The takes

Sit as you normally would when using the app. For each take: press
`Shift` + `C`, do the take for 30 to 60 seconds, press `Shift` + `D`, and
rename the file to the name given here. Keep both hands raised, palms to the
camera, unless the take says otherwise.

| File | What to do |
| --- | --- |
| `1-still.json` | Both hands held up and as still as you comfortably can. Do not try to freeze; hold them the way you would while reading the screen. |
| `2-point.json` | One hand points around the screen and clicks (pinches) on things, as in ordinary use. The other hand stays raised and idle. No marks needed. |
| `3-takeover.json` | Twenty deliberate takeovers. One hand is pointing; stop it, and start pointing with the other. Alternate hands. Press `m` at each takeover, as close as you can to the moment the new hand starts to move. Leave two or three seconds between takeovers. |
| `4-together.json` | Both hands moving at once: move them around together for a while, then do several two-hand zooms (pinch with both hands, pull apart, push together). |
| `5-relaxed.json` | Point with one hand for a few seconds, then let that hand relax and rest in the air the way it does when you stop paying attention to it: fingers curled, drifting. Repeat several times. Press `m` each time you let it relax. |
| `6-sweeps.json` | Fast sweeps: move one hand quickly from one side of the screen to the other and back, several times, then the other hand. Do not pinch at all during this take. |
| `7-still-far.json` | Take 1 again with your hands at arm's length from where they were (as far from the camera as you would ever use the app). |
| `8-point-far.json` | Take 2 again at that distance. |

Marks need pressing a key while both hands are busy. A second person at the
keyboard is the easy way. Alone, press with a knuckle of the idle hand, and
accept that the mark is a little late; the analysis shows the motion around
each mark rather than trusting its exact time.

## Reading numbers in the browser

`__handRec.summary()` in the console gives a quick check before you download:

- `rows`, `durationMs`, `marks`
- `intervals`: time between result frames in ms (`mean`, `median`, `p90`,
  `max`) and `over150`, the number of intervals longer than 150 ms.
- `noHandFrames`, `twoHandFrames`
- `hands.L` and `hands.R`:
  - `seen`: frames where the tracker reported this hand
  - `active`: frames where it also passed the pose gate (held up, palm out)
  - `gateExits`: times it was dropped by the pose gate while still in view
  - `missingAfterTwo`: of the frames that follow a frame with two hands, the
    fraction where this hand was not found
  - `labelFlips`: times a hand with this label turned up exactly where a hand
    with the other label was one frame earlier (the tracker renamed the hand)
  - `duplicates`: frames where both hands carried this label

If take 1 shows `seen` far below `rows` for a hand you were holding up, fix
the lighting or your position before recording the rest.

## Running the analysis

Node 18 or later, no install step:

```sh
node lib/hand-pointer/tools/analyzeRecording.mjs ~/Downloads/1-still.json
node lib/hand-pointer/tools/analyzeRecording.mjs ~/Downloads/*.json > report.txt
```

Distances are printed in three units:

- **fh**, frame heights: a fraction of the camera frame's height, with
  horizontal distances corrected for the frame's shape.
- **palm**, palm lengths: the distance from the wrist to the middle knuckle.
  The same movement measures the same in palm lengths at any distance from
  the camera, which is why the far takes exist: to check that it does.
- **raw**: the tracker's own 0..1 coordinates, uncorrected. Only used for the
  thumb-index gap, because that is what `pinchOn` and `pinchOff` are in.

Options: `--window=0.15` (seconds for net displacement), `--tau=0.2` (seconds
of lag for the lagged motion signal), `--ma=1` (seconds of moving average
treated as slow drift), `--jump=0.25` (palm lengths for a single-frame jump),
`--pre=200 --post=400` (ms shown around each mark), `--segments=8` (most marks
for which per-segment rows are printed).

## What each measurement is for

Constants are named as they are in the source; where the arbiter is being
reworked, both the old and new names are given.

| Section of the report | Take to read it from | What it sets |
| --- | --- | --- |
| **Jitter** (sd per axis, slow drift removed) | 1, 7 | The noise floor of a still hand. Sets the One Euro filter's `minCutoff` and the `deadzone` (`pointerParams.ts`): the deadzone should cover about 2 to 3 sd once mapped to the screen. Compare knuckle and palm centre: the steadier one is the better point to measure motion from. Compare takes 1 and 7 in palm units: if they agree, thresholds in palm lengths hold at any distance. |
| **Slow sway** (the drift removed) | 1, 5, 7 | How far a hand held in the air wanders without the user meaning anything. The handover logic must not read this as pointing: it bounds `MOVE` and `REST_RATIO` (previously `TRAVEL_MOVING`, `TRAVEL_STILL`, `STILL_RATIO`) in `handArbiter.ts` from below. |
| **Motion** (net displacement over a window; distance from a lagged position) | 1 and 5 for the floor, 2 for the signal | The `lag` columns are the arbiter's own signal. `MOVE` must sit above the p99 of a still hand (take 1) and a relaxed one (take 5), and below the p50 of a pointing hand (take 2). The ratio between the idle and the pointing hand in take 2 sets `REST_RATIO`. Change `--tau` to see what a different `MOTION_TAU` would do. |
| **Motion ramp at each mark** | 3 | How quickly a hand that starts pointing rises above the threshold, and how much the other hand moves meanwhile. Sets how long a handover must take: `EVIDENCE`, `MIN_FRAMES`, `MOTION_TAU` (previously `SWITCH_DWELL`, `TRAVEL_WINDOW`). The "other hand's largest move" line is the margin `REST_RATIO` has to work with. |
| **Frame intervals** | any | The real frame rate and how often a frame is late. Every time constant above has to be judged against it: a dwell shorter than one interval is one frame. Also sets `MAX_GAP` / `MAX_DT` and whether `maxInferenceFps` is being reached. |
| **Detection reliability**: one hand found after a two-hand frame | 1, 2, 4 | How often the tracker loses one of two hands, and whether it comes straight back. Sets `DRIVER_GRACE` (`handArbiter.ts`) and `goneMs` (`cursorDriver.ts`): both must outlast the usual dropout. |
| **Detection reliability**: pose-gate exits | 1, 2, 5 | How often a hand in view is rejected by the pose gate. In take 1 this should be zero; if not, the OFF thresholds in `palm.ts` (`PALM_OFF`, `UP_OFF`, `LEN_OFF`) are too tight. Take 5 shows whether a relaxed hand falls out of the gate. |
| **Pose measurements** (palm, up, len percentiles) | 1, 2, 5, 7 | The spread of the three pose values for hands that should count. The ON thresholds in `palm.ts` should sit below the p1 to p5 of takes 1 and 2. |
| **Detection reliability**: label flips, duplicate labels | all | How often the tracker calls a left hand right. If it happens at all, per-hand state must survive it (this is what `DRIVER_GRACE` and the glitch check absorb); if it is frequent, hands should be tracked by position rather than by label. |
| **Single-frame jumps** | 1, 2, 6 | How often a hand is reported somewhere else for one frame. Sets `REVERSAL_MIN` (the size worth rejecting) and tells whether the rejection is needed at all. |
| **Thumb-index gap** (percentiles and histogram) | 2 for both states, 5 for a relaxed hand, 6 for blur | `pinchOn` and `pinchOff` (`pointerParams.ts`). In take 2 the histogram has two humps, pinched and open: `pinchOn` belongs just above the lower hump, `pinchOff` in the empty stretch between them. Take 5 shows how close a relaxed hand sits to `pinchOn` (the reason for `PinchLatch`). Take 6 has no real pinches, so any gap below `pinchOn` there is motion blur: it sets `pinchMaxSpeed` and `PINCH_SETTLE` (`pinchGuard.ts`), and the open-hand gap bounds `aimFreezeDist`. |

Jitter and sway are only meaningful where the hand was meant to be still. In
a take with movement, read the motion tables instead.

## The file format

Plain JSON, one row per line so the file can be searched with ordinary text
tools. About 1 kB per frame with two hands in view: roughly 0.85 MB per
minute at 14 frames per second.

```jsonc
{
  "version": 1,
  "startedAt": "2026-11-14T19:39:48.556Z", // when the take began (last clear)
  "decimals": 4,                 // decimal places kept for coordinates
  "dropped": 0,                  // rows lost off the front (see below)
  "userAgent": "...",
  "frame": { "width": 640, "height": 480 },  // camera frame, px
  "params": { "pinchOn": 0.04, "...": "..." }, // tuning in force at download
  "rows": [ /* one per result frame, oldest first */ ],
  "marks": [ { "label": "m1", "at": 21040.3, "t": 20980.1, "seq": 280 } ]
}
```

A row:

```jsonc
{
  "t": 20980.1,      // when the camera frame was taken, ms (performance.now)
  "at": 21065.4,     // when its result arrived, ms; at - t is the latency
  "dt": 70.2,        // t minus the previous row's t; 0 for the first row
  "hands": [         // every hand the tracker reported; [] when none
    {
      "hand": "R",   // the tracker's label, "L" or "R"
      "conf": 0.97,  // its confidence in that label
      "pts": [0.7, 0.59, "... 42 numbers ..."],
      "pose": { "palm": 0.6, "up": 0.95, "len": 1.4 },  // see palm.ts
      "active": true // passed the pose gate and was used as input
    }
  ],
  "driver": "R",             // the hand driving the cursor, or null
  "why": "other still",      // the arbiter's reason for not changing hands
  "motion": { "L": 0.01, "R": 0.2 }, // the arbiter's motion value per hand
  "evidence": 0.2,           // its progress toward a handover, 0..1
  "primaryPinching": false,  // the driving hand is pinching
  "secondaryPinching": false,
  "fast": { "L": false, "R": false }, // too fast to start a pinch
  "mode": "hand",            // "hand" or "mouse": who owns the cursor
  "extra": { }               // anything else the app chose to add
}
```

`pts` is the 21 MediaPipe hand landmarks as `[x0, y0, x1, y1, ...]`, each from
0 to 1 across the camera frame, x left to right as the camera sees it (not
mirrored), y downward. Landmark 0 is the wrist, 4 the thumb tip, 5 the index
knuckle, 8 the index tip, 9 the middle knuckle, 17 the pinky knuckle.

`why`, `motion`, `evidence`, `fast`, `mode` and `extra` are optional and are
left out when the app does not supply them. A hand with `"active": false` was
seen but ignored.

A mark's `at` is when the key was pressed, on the same clock as a row's `t`
and `at`. `t` is the frame timestamp of the latest row at that moment, and
`seq` counts the rows recorded before it; `seq - dropped` is the index in
`rows` of the first row after the mark.

The recorder keeps the most recent 36000 rows (40 minutes at 15 frames per
second, about 35 MB as a file). Beyond that the oldest rows are discarded,
along with any marks older than them, and `dropped` says how many. Clearing
at the start of each take keeps every file small and `dropped` at 0.

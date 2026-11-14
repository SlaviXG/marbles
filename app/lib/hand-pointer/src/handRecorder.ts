// Debug recorder: captures what the tracker saw and decided on every result
// frame, so thresholds can be set from measurements instead of guesses, and so
// a recording can later be replayed through the pure logic in unit tests.
//
// Two layers:
//   - HandRecorder and summarize(): pure, no DOM, no dependencies. Safe to
//     construct and test anywhere.
//   - installHandRecorder(): the thin browser layer (window.__handRec, the
//     keys, the toast, the download). Every window/document access is inside
//     it, so importing this module touches nothing.
//
// Nothing here runs unless the caller constructs a recorder, which
// cameraPointer does only under ?debug. See RECORDING.md for how to use it.

export type Side = "L" | "R";

// One raw detected hand, including a hand the pose gate rejected.
export interface RecordedHand {
  hand: Side;
  conf: number;
  // All 21 landmarks, flat [x0,y0,x1,y1,...] in normalized frame coords
  // (unmirrored, y down), rounded on the way in.
  pts: number[];
  // The pose gate's measurements (palm.ts) and its verdict, as the app
  // computed them.
  pose?: { palm: number; up: number; len: number };
  active: boolean;
}

// What the caller hands to push(): one inference result plus the decisions
// taken on it. Only t, at and hands are required, so the format does not
// depend on what the arbiter happens to expose this week.
export interface HandRowInput {
  // The frame timestamp in ms, as sent to the worker with the frame.
  t: number;
  // When the result arrived on the main thread (performance.now()).
  at: number;
  hands: RecordedHand[];
  // Which hand drives the cursor this frame, or null when none does.
  driver?: Side | null;
  // The arbiter's reason for not switching (HandArbiter.why).
  why?: string;
  // Per-hand motion as the arbiter saw it, in whatever unit it uses.
  motion?: Partial<Record<Side, number>>;
  // The arbiter's evidence for a switch: one number, or one per hand.
  evidence?: number | Partial<Record<Side, number>>;
  primaryPinching?: boolean;
  secondaryPinching?: boolean;
  // Per-hand pinch guard state: moving too fast to start a pinch.
  fast?: Partial<Record<Side, boolean>>;
  // Which source owns the cursor ("hand" or "mouse").
  mode?: string;
  // Anything else worth having. Must be JSON-serializable; numbers inside it
  // are stored as given (not rounded).
  extra?: Record<string, unknown>;
}

// A stored row: the input, rounded, plus dt.
export interface HandRow extends HandRowInput {
  // ms between this frame's t and the previous row's t. 0 for the first row
  // of a recording (after construction or clear()).
  dt: number;
  driver: Side | null;
  primaryPinching: boolean;
  secondaryPinching: boolean;
}

export interface HandMark {
  label: string;
  // When the mark was made (same clock as a row's `at`).
  at: number;
  // t of the latest row at that moment, or null if there was none.
  t: number | null;
  // How many rows had been pushed since the last clear() when the mark was
  // made. Subtract the document's `dropped` to get an index into `rows`.
  seq: number;
}

export interface RecordingMeta {
  userAgent?: string;
  // The camera frame in px. Needed to turn normalized x into real proportions.
  frame?: { width: number; height: number };
  // The tuning parameters in force (PointerParams), for reference.
  params?: unknown;
}

export const RECORDING_VERSION = 1;

export interface RecordingDocument extends RecordingMeta {
  version: number;
  // Wall-clock time of the recording's start (construction or last clear()),
  // ISO 8601.
  startedAt: string;
  // Decimal places kept for landmark coordinates.
  decimals: number;
  // Rows dropped from the front because the cap was reached.
  dropped: number;
  rows: HandRow[];
  marks: HandMark[];
}

export interface HandRecorderOptions {
  // Most rows kept. See DEFAULT_CAP.
  cap?: number;
  // Decimal places for landmark coordinates and other fractional values.
  decimals?: number;
  // Read when a document is produced, so it reflects the session at download
  // time (the frame size is not known until the camera has started).
  meta?: () => RecordingMeta;
  // Clock for marks, in the same timebase as a row's `at`. Injectable for
  // tests; defaults to performance.now().
  now?: () => number;
}

// The cap. A ring buffer: when full, the OLDEST row is dropped.
//
// Why a ring and not stop-at-cap: recording starts by itself when the camera
// starts under ?debug, and the user may have the page open for a long while
// before deciding to do a take. Whatever they just did is what they want to
// download, so the newest rows must always be the ones kept. Marks are tied to
// time, not to array positions, so dropping old rows does not break them; a
// mark older than every kept row is dropped with them.
//
// 36000 rows is 40 minutes at 15 fps (20 minutes would fit even at 30 fps).
// A two-hand row holds 84 landmark numbers and costs roughly 1.2 kB in
// memory, so a full buffer is about 45 MB, and about 35 MB as JSON.
export const DEFAULT_CAP = 36000;
// 4 places is 0.06 px on a 640 px frame, far below landmark noise (~1 px), and
// brings a two-hand row to about 1 kB of JSON (0.85 MB a minute at 14 fps).
export const DEFAULT_DECIMALS = 4;

function roundTo(v: number, scale: number): number {
  // JSON has no NaN or Infinity; a bad value becomes 0 rather than null so a
  // reader never has to handle a non-number in a numeric field.
  return Number.isFinite(v) ? Math.round(v * scale) / scale : 0;
}

function roundSides(
  v: Partial<Record<Side, number>>,
  scale: number,
): Partial<Record<Side, number>> {
  const out: Partial<Record<Side, number>> = {};
  if (v.L !== undefined) out.L = roundTo(v.L, scale);
  if (v.R !== undefined) out.R = roundTo(v.R, scale);
  return out;
}

export class HandRecorder {
  readonly cap: number;
  readonly decimals: number;
  private scale: number;
  private meta?: () => RecordingMeta;
  private now: () => number;
  // Ring storage: `buf` grows to `cap`, then `head` is the oldest row.
  private buf: HandRow[] = [];
  private head = 0;
  private markList: HandMark[] = [];
  private lastT = NaN;
  private pushed = 0;
  private started = new Date().toISOString();

  constructor(options: HandRecorderOptions = {}) {
    this.cap = Math.max(1, Math.floor(options.cap ?? DEFAULT_CAP));
    this.decimals = options.decimals ?? DEFAULT_DECIMALS;
    this.scale = 10 ** this.decimals;
    this.meta = options.meta;
    this.now =
      options.now ??
      (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  // Rows currently held.
  get size(): number {
    return this.buf.length;
  }

  // Rows dropped from the front since the last clear().
  get dropped(): number {
    return this.pushed - this.buf.length;
  }

  // Oldest first. Builds a new array, so read it once rather than per frame.
  get rows(): HandRow[] {
    return this.head === 0
      ? this.buf.slice()
      : this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
  }

  get marks(): HandMark[] {
    return this.markList.slice();
  }

  // Record one result frame. Copies and rounds what it is given, so the
  // caller may reuse or mutate its objects afterwards. Returns the stored row.
  push(input: HandRowInput): HandRow {
    const s = this.scale;
    const row: HandRow = {
      // Timestamps keep 0.1 ms whatever `decimals` is.
      t: roundTo(input.t, 10),
      at: roundTo(input.at, 10),
      dt: Number.isNaN(this.lastT) ? 0 : roundTo(input.t - this.lastT, 10),
      hands: input.hands.map((h) => {
        const pts = new Array<number>(h.pts.length);
        for (let i = 0; i < h.pts.length; i++) pts[i] = roundTo(h.pts[i], s);
        const out: RecordedHand = {
          hand: h.hand,
          conf: roundTo(h.conf, 1000),
          pts,
          active: h.active,
        };
        if (h.pose) {
          out.pose = {
            palm: roundTo(h.pose.palm, s),
            up: roundTo(h.pose.up, s),
            len: roundTo(h.pose.len, s),
          };
        }
        return out;
      }),
      driver: input.driver ?? null,
      primaryPinching: !!input.primaryPinching,
      secondaryPinching: !!input.secondaryPinching,
    };
    if (input.why !== undefined) row.why = input.why;
    if (input.motion) row.motion = roundSides(input.motion, s);
    if (input.evidence !== undefined) {
      row.evidence =
        typeof input.evidence === "number"
          ? roundTo(input.evidence, s)
          : roundSides(input.evidence, s);
    }
    if (input.fast) row.fast = { ...input.fast };
    if (input.mode !== undefined) row.mode = input.mode;
    if (input.extra) row.extra = { ...input.extra };
    this.lastT = input.t;
    this.pushed++;

    if (this.buf.length < this.cap) {
      this.buf.push(row);
    } else {
      this.buf[this.head] = row;
      this.head = (this.head + 1) % this.cap;
      // Marks made before every kept row no longer point at anything.
      const oldest = this.buf[this.head].at;
      if (this.markList.length && this.markList[0].at < oldest) {
        this.markList = this.markList.filter((m) => m.at >= oldest);
      }
    }
    return row;
  }

  // Note a moment ("taking over now"). `at` defaults to the clock.
  mark(label: string, at: number = this.now()): HandMark {
    const last = this.buf.length
      ? this.buf[(this.head + this.buf.length - 1) % this.buf.length]
      : null;
    const m: HandMark = {
      label,
      at: roundTo(at, 10),
      t: last ? last.t : null,
      seq: this.pushed,
    };
    this.markList.push(m);
    return m;
  }

  // Start a new recording: drop everything and restart dt and startedAt.
  clear(): void {
    this.buf = [];
    this.head = 0;
    this.markList = [];
    this.lastT = NaN;
    this.pushed = 0;
    this.started = new Date().toISOString();
  }

  // The versioned document. JSON.stringify(recorder) calls this.
  toJSON(): RecordingDocument {
    const meta = this.meta ? this.meta() : {};
    const doc: RecordingDocument = {
      version: RECORDING_VERSION,
      startedAt: this.started,
      decimals: this.decimals,
      dropped: this.dropped,
      rows: [],
      marks: [],
    };
    if (meta.userAgent !== undefined) doc.userAgent = meta.userAgent;
    if (meta.frame && meta.frame.width > 0 && meta.frame.height > 0) doc.frame = meta.frame;
    if (meta.params !== undefined) doc.params = meta.params;
    // Last, so the small fields come first in the file.
    doc.rows = this.rows;
    doc.marks = this.marks;
    return doc;
  }

  // The document as text: compact, but with one row per line so the file can
  // be searched and diffed. Plain JSON; JSON.parse reads it back.
  serialize(): string {
    const { rows, marks, ...head } = this.toJSON();
    const headText = JSON.stringify(head).slice(0, -1);
    const rowText = rows.map((r) => JSON.stringify(r)).join(",\n");
    return `${headText},"rows":[\n${rowText}\n],\n"marks":${JSON.stringify(marks)}}\n`;
  }

  // Quick statistics; see summarize().
  summary(): RecordingSummary {
    const frame = this.meta?.().frame;
    const aspect = frame && frame.width > 0 && frame.height > 0 ? frame.width / frame.height : undefined;
    return summarize(this.rows, this.marks, aspect);
  }
}

// ---- summary ---------------------------------------------------------------

export interface IntervalStats {
  count: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
  // Intervals longer than SLOW_FRAME_MS: frames the cursor visibly waited for.
  over150: number;
}

export interface HandLabelStats {
  // Frames with at least one hand carrying this label.
  seen: number;
  // Of those, frames where it passed the pose gate.
  active: number;
  // Frames where it was seen on this frame and the last, and went from
  // active to not: the pose gate dropping a hand that is still there.
  gateExits: number;
  // Of the frames that follow a two-hand frame, the fraction where this hand
  // is no longer detected. The detector losing one of two hands.
  missingAfterTwo: number;
  // Times a hand with this label appeared exactly where a hand with the
  // OTHER label was on the previous frame, while no hand of this label had
  // been there: the detector renaming a hand, seen through position.
  labelFlips: number;
  // Frames where two hands both carried this label.
  duplicates: number;
}

export interface RecordingSummary {
  rows: number;
  marks: number;
  // Last frame timestamp minus the first, in ms.
  durationMs: number;
  intervals: IntervalStats;
  noHandFrames: number;
  twoHandFrames: number;
  hands: Record<Side, HandLabelStats>;
}

export const SLOW_FRAME_MS = 150;
// Two frames further apart than this are not compared for continuity: the
// hand may have gone anywhere in between.
const CONTINUITY_GAP_MS = 250;
// A hand "continues a track" when its palm centre is within this many palm
// lengths of where the track was one frame earlier. At 15 fps that covers
// movement up to roughly 1.5 frame heights per second at desk distance;
// faster sweeps are simply not judged, which errs toward counting too few.
const CONTINUITY_PALMS = 0.5;

// Palm centre (mean of wrist, index, middle and pinky knuckles) and palm
// length (wrist to middle knuckle), in frame heights.
function palmOf(pts: number[], aspect: number): { x: number; y: number; len: number } {
  const x = ((pts[0] + pts[10] + pts[18] + pts[34]) / 4) * aspect;
  const y = (pts[1] + pts[11] + pts[19] + pts[35]) / 4;
  const len = Math.hypot((pts[18] - pts[0]) * aspect, pts[19] - pts[1]);
  return { x, y, len };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// rows: oldest first. aspect: frame width / height (4:3 if unknown).
export function summarize(
  rows: readonly HandRow[],
  marks: readonly HandMark[] = [],
  aspect: number = 4 / 3,
): RecordingSummary {
  const blank = (): HandLabelStats => ({
    seen: 0,
    active: 0,
    gateExits: 0,
    missingAfterTwo: 0,
    labelFlips: 0,
    duplicates: 0,
  });
  const hands: Record<Side, HandLabelStats> = { L: blank(), R: blank() };
  const missing: Record<Side, number> = { L: 0, R: 0 };
  const dts: number[] = [];
  let afterTwo = 0;
  let noHandFrames = 0;
  let twoHandFrames = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const gap = prev ? row.t - prev.t : Infinity;
    if (prev) dts.push(gap);
    if (row.hands.length === 0) noHandFrames++;
    if (row.hands.length >= 2) twoHandFrames++;

    for (const side of ["L", "R"] as const) {
      const mine = row.hands.filter((h) => h.hand === side);
      if (mine.length > 0) {
        hands[side].seen++;
        if (mine.some((h) => h.active)) hands[side].active++;
      }
      if (mine.length > 1) hands[side].duplicates++;
      if (prev && mine.length > 0) {
        const before = prev.hands.filter((h) => h.hand === side);
        if (before.some((h) => h.active) && !mine.some((h) => h.active)) hands[side].gateExits++;
      }
    }

    if (!prev) continue;
    if (prev.hands.length >= 2) {
      afterTwo++;
      for (const side of ["L", "R"] as const) {
        const had = prev.hands.some((h) => h.hand === side);
        if (had && !row.hands.some((h) => h.hand === side)) missing[side]++;
      }
    }
    if (gap > CONTINUITY_GAP_MS) continue;
    for (const h of row.hands) {
      const here = palmOf(h.pts, aspect);
      const reach = here.len * CONTINUITY_PALMS;
      const near = (o: RecordedHand) => {
        const there = palmOf(o.pts, aspect);
        return Math.hypot(here.x - there.x, here.y - there.y) < reach;
      };
      const sameWasHere = prev.hands.some((o) => o.hand === h.hand && near(o));
      const otherWasHere = prev.hands.some((o) => o.hand !== h.hand && near(o));
      if (otherWasHere && !sameWasHere) hands[h.hand].labelFlips++;
    }
  }

  for (const side of ["L", "R"] as const) {
    hands[side].missingAfterTwo = afterTwo > 0 ? missing[side] / afterTwo : 0;
  }
  const sorted = dts.slice().sort((a, b) => a - b);
  return {
    rows: rows.length,
    marks: marks.length,
    durationMs: rows.length > 1 ? rows[rows.length - 1].t - rows[0].t : 0,
    intervals: {
      count: dts.length,
      mean: dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : 0,
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      over150: dts.filter((d) => d > SLOW_FRAME_MS).length,
    },
    noHandFrames,
    twoHandFrames,
    hands,
  };
}

// ---- browser layer ---------------------------------------------------------

export interface InstallOptions {
  // Key that drops a mark. Matched against KeyboardEvent.key, case-insensitive,
  // with no modifier held.
  markKey?: string;
  // Keys that download and clear. Matched with Shift held (and no Ctrl, Alt or
  // Cmd, so browser shortcuts such as Cmd+Shift+D are left alone).
  downloadKey?: string;
  clearKey?: string;
  // Name of the global the console API is exposed under.
  globalName?: string;
  // Start of the default download filename.
  filePrefix?: string;
}

// What installHandRecorder puts on window (as window.__handRec by default).
export interface HandRecorderConsole {
  readonly rows: HandRow[];
  readonly marks: HandMark[];
  mark(label?: string): HandMark;
  clear(): void;
  // Saves the recording as a JSON file and returns the filename used.
  download(filename?: string): string;
  summary(): RecordingSummary;
}

const TOAST_MS = 1400;

// Wire a recorder to the page: the console API, the keys and the toast.
// Returns a function that removes all of it. Does nothing (and returns a
// no-op) where there is no window or document.
export function installHandRecorder(
  recorder: HandRecorder,
  options: InstallOptions = {},
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const markKey = (options.markKey ?? "m").toLowerCase();
  const downloadKey = (options.downloadKey ?? "d").toLowerCase();
  const clearKey = (options.clearKey ?? "c").toLowerCase();
  const globalName = options.globalName ?? "__handRec";
  const filePrefix = options.filePrefix ?? "hand-recording";

  let markCount = 0;
  let toastEl: HTMLDivElement | null = null;
  let toastTimer = 0;

  const toast = (text: string) => {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("role", "status");
      toastEl.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;" +
        "padding:6px 12px;border-radius:6px;background:rgba(0,0,0,.82);color:#fff;" +
        "font:13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none";
    }
    toastEl.textContent = text;
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl?.remove(), TOAST_MS);
  };

  const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  };

  const api: HandRecorderConsole = {
    get rows() {
      return recorder.rows;
    },
    get marks() {
      return recorder.marks;
    },
    mark(label?: string) {
      markCount++;
      const m = recorder.mark(label ?? `m${markCount}`);
      toast(`mark ${m.label}  (${recorder.size} rows)`);
      return m;
    },
    clear() {
      recorder.clear();
      markCount = 0;
      toast("recording cleared");
    },
    download(filename?: string) {
      let name = filename ?? `${filePrefix}-${stamp()}`;
      if (!name.endsWith(".json")) name += ".json";
      const text = recorder.serialize();
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser time to start the save before the URL goes away.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(
        `saved ${name}  (${recorder.size} rows, ${recorder.marks.length} marks, ` +
          `${(text.length / 1e6).toFixed(2)} MB)`,
      );
      return name;
    },
    summary() {
      return recorder.summary();
    },
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    // Typing in a field is not a command.
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (!e.shiftKey && key === markKey) api.mark();
    else if (e.shiftKey && key === downloadKey) api.download();
    else if (e.shiftKey && key === clearKey) api.clear();
    else return;
    e.preventDefault();
  };

  const host = window as unknown as Record<string, unknown>;
  host[globalName] = api;
  window.addEventListener("keydown", onKey);

  return () => {
    window.removeEventListener("keydown", onKey);
    if (host[globalName] === api) delete host[globalName];
    window.clearTimeout(toastTimer);
    toastEl?.remove();
    toastEl = null;
  };
}

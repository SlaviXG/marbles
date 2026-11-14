#!/usr/bin/env node
// Measurements from a hand-pointer recording (see ../RECORDING.md).
//
//   node analyzeRecording.mjs recording.json [more.json ...] [options]
//
// Everything is computed from the raw landmarks in the file, not from the
// values the app derived at the time, so the numbers stay valid when the
// app's own logic changes. The two exceptions are the pose-gate exit count,
// which reads each hand's recorded `active` flag, and the pinch thresholds
// drawn on the gap histogram, which come from the recorded params.
//
// Units:
//   fh    frame heights. Normalized y as is; normalized x times the frame's
//         aspect, so both axes measure the same real distance.
//   palm  palm lengths: wrist (landmark 0) to middle knuckle (9). Divides out
//         how far the hand is from the camera.
//   raw   normalized frame coords with no aspect correction, which is what
//         the app's pinchOn / pinchOff are compared against.
//
// Options (all optional):
//   --window=0.15  seconds over which net displacement ("motion") is measured
//   --tau=0.2      seconds of lag for the lagged-position motion signal
//   --ma=1         seconds of moving average removed as slow drift
//   --jump=0.25    palm lengths a point must step, and step back, to count as
//                  a single-frame jump
//   --pre=200      ms before each mark where its motion ramp starts
//   --post=400     ms after each mark where it ends
//   --gap=250      ms; frames further apart than this are not compared
//   --segments=8   per-segment rows are printed only when there are at most
//                  this many marks (a take with twenty marks has no use for
//                  them); 0 prints the whole-recording rows only

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const SIDES = ["L", "R"];

// ---- arguments -------------------------------------------------------------

const opt = { window: 0.15, tau: 0.2, ma: 1, jump: 0.25, pre: 200, post: 400, gap: 250, segments: 8 };
const files = [];
for (const a of process.argv.slice(2)) {
  const m = /^--(\w+)=(.+)$/.exec(a);
  if (m && m[1] in opt && Number.isFinite(Number(m[2]))) opt[m[1]] = Number(m[2]);
  else if (a.startsWith("--")) fail(`unknown option ${a}`);
  else files.push(a);
}
if (files.length === 0) fail("usage: node analyzeRecording.mjs recording.json [more.json ...] [--window=0.15] [--ma=1] [--jump=0.25] [--pre=200] [--post=400]");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---- small helpers ---------------------------------------------------------

const sum = (a) => a.reduce((s, v) => s + v, 0);
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
function sd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
}
// Spread as a standard deviation, estimated from the median absolute
// deviation: equal to sd for Gaussian noise, but not inflated by the few
// samples next to a deliberate movement that the moving average smears.
function robustSd(a) {
  if (a.length < 2) return NaN;
  const m = quantile(a, 0.5);
  return 1.4826 * quantile(a.map((v) => Math.abs(v - m)), 0.5);
}
// q in 0..1, linear interpolation between ranks.
function quantile(a, q) {
  if (a.length === 0) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const f = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const pct = (n, of) => (of > 0 ? `${((100 * n) / of).toFixed(2)}%` : "-");
const rate = (n, of) => `${n} (${pct(n, of)} of ${of})`;

// Print rows of cells as an aligned table; the first row is the header.
function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c] ?? "").length)));
  for (const r of rows) {
    console.log("  " + r.map((v, c) => (c === 0 ? String(v).padEnd(w[c]) : String(v).padStart(w[c]))).join("  "));
  }
}
function heading(text) {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

// ---- reading a recording ---------------------------------------------------

// One hand on one frame, reduced to what the measurements need.
function measureHand(h, aspect) {
  const p = h.pts;
  const X = (i) => p[i * 2] * aspect;
  const Y = (i) => p[i * 2 + 1];
  const palm = Math.hypot(X(9) - X(0), Y(9) - Y(0));
  // The pose gate's three measurements (same formulas as palm.ts).
  const ax = X(5) - X(0), ay = Y(5) - Y(0);
  const bx = X(17) - X(0), by = Y(17) - Y(0);
  const cross = Math.hypot(ax, ay) * Math.hypot(bx, by);
  const facing = cross > 1e-9 ? (-(ax * by - ay * bx) / cross) * (h.hand === "R" ? 1 : -1) : 0;
  const width = Math.hypot(X(17) - X(5), Y(17) - Y(5));
  const gapRaw = Math.hypot(p[16] - p[8], p[17] - p[9]);
  const gapFh = Math.hypot(X(8) - X(4), Y(8) - Y(4));
  return {
    hand: h.hand,
    active: !!h.active,
    kx: X(5), ky: Y(5), // index knuckle
    cx: (X(0) + X(5) + X(9) + X(17)) / 4, // palm centre
    cy: (Y(0) + Y(5) + Y(9) + Y(17)) / 4,
    palm,
    gapRaw,
    gapPalm: palm > 1e-9 ? gapFh / palm : NaN,
    pose: {
      palm: facing,
      up: palm > 1e-9 ? -(Y(9) - Y(0)) / palm : 0,
      len: width > 1e-9 ? palm / width : 0,
    },
  };
}

function load(file) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(doc.rows)) fail(`${file}: not a recording (no rows)`);
  if (doc.version !== 1) console.warn(`${file}: version ${doc.version}, this script was written for 1`);
  const aspect = doc.frame?.width > 0 && doc.frame?.height > 0 ? doc.frame.width / doc.frame.height : 4 / 3;
  const frames = doc.rows.map((r) => ({
    t: r.t,
    at: r.at,
    hands: (r.hands ?? []).filter((h) => h.pts?.length >= 42).map((h) => measureHand(h, aspect)),
  }));
  const marks = (doc.marks ?? []).slice().sort((a, b) => a.at - b.at);
  return { doc, aspect, frames, marks };
}

// Per label, the frames where exactly one hand carries it, split into runs
// wherever two such frames are more than opt.gap apart. Each sample remembers its frame index.
function tracks(frames) {
  const out = { L: [], R: [] };
  for (const side of SIDES) {
    let run = null;
    for (let i = 0; i < frames.length; i++) {
      const mine = frames[i].hands.filter((h) => h.hand === side);
      // A missed or doubled frame is skipped; only a long gap ends the run.
      if (mine.length !== 1) continue;
      const s = { i, t: frames[i].t, ...mine[0] };
      if (!run || s.t - run[run.length - 1].t > opt.gap) out[side].push((run = []));
      run.push(s);
    }
  }
  return out;
}

// Segments between marks. A frame's moment is its `t` (when the camera frame
// was taken); a mark's is its `at`. Both are performance.now().
function segmentsOf(frames, marks) {
  const edges = marks.map((m) => m.at);
  const names = [];
  for (let k = 0; k <= marks.length; k++) {
    const from = k === 0 ? "start" : marks[k - 1].label;
    const to = k === marks.length ? "end" : marks[k].label;
    names.push(`${from}..${to}`);
  }
  const of = (t) => {
    let k = 0;
    while (k < edges.length && t >= edges[k]) k++;
    return k;
  };
  return { names, of };
}

// ---- the measurements ------------------------------------------------------

function overview({ doc, aspect, frames, marks }) {
  heading("Overview");
  const dur = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
  const count = [0, 0, 0];
  for (const fr of frames) count[Math.min(2, fr.hands.length)]++;
  console.log(`  started        ${doc.startedAt ?? "?"}`);
  console.log(`  frames         ${frames.length} over ${dur.toFixed(1)} s (${dur > 0 ? ((frames.length - 1) / dur).toFixed(1) : "-"} fps)`);
  console.log(`  camera frame   ${doc.frame ? `${doc.frame.width}x${doc.frame.height}` : "unknown, assuming 4:3"} (aspect ${aspect.toFixed(3)})`);
  console.log(`  marks          ${marks.length}${marks.length ? ": " + marks.map((m) => m.label).join(" ") : ""}`);
  console.log(`  hands in frame none ${pct(count[0], frames.length)}, one ${pct(count[1], frames.length)}, two ${pct(count[2], frames.length)}`);
  if (doc.dropped) console.log(`  note           ${doc.dropped} earlier rows were dropped at the recorder's cap`);
}

function intervals({ frames }) {
  heading("Frame intervals (ms between frame timestamps)");
  const dts = [];
  const lat = [];
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) dts.push(frames[i].t - frames[i - 1].t);
    if (Number.isFinite(frames[i].at)) lat.push(frames[i].at - frames[i].t);
  }
  table([
    ["", "mean", "median", "p90", "p99", "max"],
    ["interval", f(mean(dts), 1), f(quantile(dts, 0.5), 1), f(quantile(dts, 0.9), 1), f(quantile(dts, 0.99), 1), f(maxOf(dts), 1)],
    ["latency", f(mean(lat), 1), f(quantile(lat, 0.5), 1), f(quantile(lat, 0.9), 1), f(quantile(lat, 0.99), 1), f(maxOf(lat), 1)],
  ]);
  console.log(`  intervals over 150 ms: ${rate(dts.filter((d) => d > 150).length, dts.length)}`);
  console.log(`  intervals over ${opt.gap} ms: ${rate(dts.filter((d) => d > opt.gap).length, dts.length)}`);
  console.log("  (latency: frame taken -> result back on the main thread)");
}

function reliability({ frames, aspect }) {
  heading("Detection reliability (events per frame)");
  let afterTwo = 0, oneMissing = 0, bothMissing = 0, blips = 0;
  const per = { L: null, R: null };
  for (const s of SIDES) per[s] = { seen: 0, active: 0, pairs: 0, exits: 0, missing: 0, flips: 0, dups: 0 };
  let compared = 0;
  const near = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.5 * a.palm;

  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i];
    for (const s of SIDES) {
      const mine = cur.hands.filter((h) => h.hand === s);
      if (mine.length) per[s].seen++;
      if (mine.some((h) => h.active)) per[s].active++;
      if (mine.length > 1) per[s].dups++;
    }
    if (i === 0) continue;
    const prev = frames[i - 1];
    if (cur.t - prev.t > opt.gap) continue;
    compared++;
    if (prev.hands.length >= 2) {
      afterTwo++;
      if (cur.hands.length === 1) {
        oneMissing++;
        const next = frames[i + 1];
        if (next && next.t - cur.t <= opt.gap && next.hands.length >= 2) blips++;
      }
      if (cur.hands.length === 0) bothMissing++;
      for (const s of SIDES) {
        if (prev.hands.some((h) => h.hand === s) && !cur.hands.some((h) => h.hand === s)) per[s].missing++;
      }
    }
    for (const s of SIDES) {
      const was = prev.hands.filter((h) => h.hand === s);
      const is = cur.hands.filter((h) => h.hand === s);
      if (was.length && is.length) {
        per[s].pairs++;
        if (was.some((h) => h.active) && !is.some((h) => h.active)) per[s].exits++;
      }
    }
    // A label flip: this hand sits where a hand with the other label was one
    // frame ago, and no hand with its own label was there.
    for (const h of cur.hands) {
      const same = prev.hands.some((o) => o.hand === h.hand && near(h, o));
      const other = prev.hands.some((o) => o.hand !== h.hand && near(h, o));
      if (other && !same) per[h.hand].flips++;
    }
  }

  console.log(`  after a two-hand frame, exactly one hand found: ${rate(oneMissing, afterTwo)}`);
  console.log(`    of those, both back on the next frame:       ${rate(blips, oneMissing)}`);
  console.log(`  after a two-hand frame, no hand found:         ${rate(bothMissing, afterTwo)}`);
  console.log();
  table([
    ["hand", "seen", "active", "lost after two-hand frame", "pose-gate exits", "label flips", "duplicate label"],
    ...SIDES.map((s) => [
      s,
      per[s].seen,
      `${per[s].active} (${pct(per[s].active, per[s].seen)})`,
      rate(per[s].missing, afterTwo),
      rate(per[s].exits, per[s].pairs),
      rate(per[s].flips, compared),
      rate(per[s].dups, frames.length),
    ]),
  ]);
  console.log("  pose-gate exits: seen on both frames, active on the first and not the second (the app's own `active` flag).");
  console.log("  label flips: counted against the label the hand was given; aspect " + aspect.toFixed(2) + ", reach 0.5 palm.");
}

// Residual after removing a centred moving average, for one coordinate
// series of one run. Samples too near the run's ends for a full window are
// left out (NaN), since a one-sided average does not remove a steady drift.
function detrend(run, key) {
  const half = (opt.ma * 1000) / 2;
  const drift = new Array(run.length).fill(NaN);
  let lo = 0, hi = 0, acc = 0;
  for (let i = 0; i < run.length; i++) {
    while (hi < run.length && run[hi].t <= run[i].t + half) acc += run[hi++][key];
    while (run[lo].t < run[i].t - half) acc -= run[lo++][key];
    const full = run[i].t - run[0].t >= half && run[run.length - 1].t - run[i].t >= half;
    if (full && hi - lo >= 5) drift[i] = acc / (hi - lo);
  }
  return drift;
}

// Net displacement over opt.window, the way a windowed motion signal sees
// it: from the newest sample at least one window old to now.
function motionOf(run, kx, ky) {
  const w = opt.window * 1000;
  const out = new Array(run.length).fill(NaN);
  let ref = 0;
  for (let i = 1; i < run.length; i++) {
    while (ref + 1 < i && run[i].t - run[ref + 1].t >= w) ref++;
    if (run[i].t - run[ref].t >= w * 0.5) out[i] = Math.hypot(run[i][kx] - run[ref][kx], run[i][ky] - run[ref][ky]);
  }
  return out;
}

// Distance from an exponentially lagged copy of the position (time constant
// opt.tau), read before the copy moves: the signal handArbiter.ts's
// MotionTracker produces, without its glitch correction. Stored on each
// sample under `name`, in the units of the coords.
function lagMotion(run, kx, ky, name) {
  let lx = run[0][kx], ly = run[0][ky];
  run[0][name] = 0;
  for (let i = 1; i < run.length; i++) {
    run[i][name] = Math.hypot(run[i][kx] - lx, run[i][ky] - ly);
    const a = 1 - Math.exp(-(run[i].t - run[i - 1].t) / 1000 / opt.tau);
    lx += (run[i][kx] - lx) * a;
    ly += (run[i][ky] - ly) * a;
  }
}

function steadiness({ frames, marks }, trk) {
  const seg = segmentsOf(frames, marks);
  // bucket[segment or "all"][side] -> arrays
  const make = () => ({ palm: [], kx: [], ky: [], cx: [], cy: [], dkx: [], dky: [], mk: [], mkPalm: [], lagK: [], lagC: [], n: 0 });
  const buckets = new Map();
  const get = (name, s) => {
    const key = `${name}|${s}`;
    if (!buckets.has(key)) buckets.set(key, make());
    return buckets.get(key);
  };
  for (const s of SIDES) {
    for (const run of trk[s]) {
      const d = { kx: detrend(run, "kx"), ky: detrend(run, "ky"), cx: detrend(run, "cx"), cy: detrend(run, "cy") };
      const mk = motionOf(run, "kx", "ky");
      for (let i = 0; i < run.length; i++) {
        for (const name of ["all", seg.names[seg.of(run[i].t)]]) {
          const b = get(name, s);
          b.n++;
          b.palm.push(run[i].palm);
          if (Number.isFinite(d.kx[i])) {
            b.kx.push(run[i].kx - d.kx[i]);
            b.ky.push(run[i].ky - d.ky[i]);
            b.cx.push(run[i].cx - d.cx[i]);
            b.cy.push(run[i].cy - d.cy[i]);
            b.dkx.push(d.kx[i]);
            b.dky.push(d.ky[i]);
          }
          if (Number.isFinite(mk[i])) {
            b.mk.push(mk[i]);
            b.mkPalm.push(mk[i] / run[i].palm);
          }
          b.lagK.push(run[i].lagK / run[i].palm);
          b.lagC.push(run[i].lagC / run[i].palm);
        }
      }
    }
  }
  const order = ["all", ...(marks.length && marks.length <= opt.segments ? seg.names : [])];
  const each = (fn) => {
    const rows = [];
    for (const name of order) {
      for (const s of SIDES) {
        const b = buckets.get(`${name}|${s}`);
        if (b && b.n >= 10) rows.push(fn(name, s, b, quantile(b.palm, 0.5)));
      }
    }
    return rows;
  };
  const span = (a) => quantile(a, 0.975) - quantile(a, 0.025);

  heading(`Jitter: sd per axis after removing a ${opt.ma} s moving average`);
  table([
    ["segment", "hand", "frames", "palm fh", "knuckle x fh", "y fh", "x palm", "y palm", "centre x fh", "y fh", "x palm", "y palm"],
    ...each((name, s, b, palm) => [
      name, s, b.n, f(palm, 3),
      f(robustSd(b.kx), 5), f(robustSd(b.ky), 5), f(robustSd(b.kx) / palm, 4), f(robustSd(b.ky) / palm, 4),
      f(robustSd(b.cx), 5), f(robustSd(b.cy), 5), f(robustSd(b.cx) / palm, 4), f(robustSd(b.cy) / palm, 4),
    ]),
  ]);
  console.log("  knuckle: index knuckle (landmark 5). centre: mean of landmarks 0, 5, 9, 17. palm fh: median palm length.");
  console.log("  sd is the robust estimate (1.4826 x median absolute deviation). Trust it in segments where the hand was held still.");

  heading("Slow sway: the drift that was removed (index knuckle)");
  table([
    ["segment", "hand", "sd x fh", "sd y fh", "range x fh", "range y fh", "sd x palm", "sd y palm", "range x palm", "range y palm"],
    ...each((name, s, b, palm) => [
      name, s,
      f(sd(b.dkx), 4), f(sd(b.dky), 4), f(span(b.dkx), 4), f(span(b.dky), 4),
      f(sd(b.dkx) / palm, 3), f(sd(b.dky) / palm, 3), f(span(b.dkx) / palm, 3), f(span(b.dky) / palm, 3),
    ]),
  ]);
  console.log("  range: middle 95% of the drift. Only meaningful in segments where the hand was meant to be still.");

  heading(`Motion: net displacement over ${Math.round(opt.window * 1000)} ms (net), and distance from a ${opt.tau} s lagged position (lag)`);
  const q = (a, d) => [f(quantile(a, 0.5), d), f(quantile(a, 0.9), d), f(quantile(a, 0.99), d), f(maxOf(a), d)];
  table([
    ["segment", "hand", "net knuckle fh p50", "p90", "p99", "max", "net knuckle palm p50", "p90", "p99", "max", "lag knuckle palm p50", "p90", "p99", "max", "lag centre palm p50", "p90", "p99", "max"],
    ...each((name, s, b) => [name, s, ...q(b.mk, 4), ...q(b.mkPalm, 3), ...q(b.lagK, 3), ...q(b.lagC, 3)]),
  ]);
  console.log("  A still hand's p99 is the floor a 'moving' threshold must clear; a pointing hand's p50 is what it must catch.");
}

function jumps(trk) {
  heading(`Single-frame jumps (a step of more than ${opt.jump} palm, and back, on the index knuckle)`);
  const rows = [["hand", "jumps", "largest palm", "at (s from start)"]];
  let t0 = Infinity;
  for (const s of SIDES) for (const run of trk[s]) if (run.length) t0 = Math.min(t0, run[0].t);
  for (const s of SIDES) {
    let n = 0, triples = 0, largest = 0;
    const when = [];
    for (const run of trk[s]) {
      for (let i = 1; i + 1 < run.length; i++) {
        triples++;
        const a = run[i - 1], b = run[i], c = run[i + 1];
        const thr = opt.jump * b.palm;
        const out = Math.hypot(b.kx - a.kx, b.ky - a.ky);
        const back = Math.hypot(c.kx - b.kx, c.ky - b.ky);
        const net = Math.hypot(c.kx - a.kx, c.ky - a.ky);
        if (out > thr && back > thr && net < 0.5 * Math.min(out, back)) {
          n++;
          largest = Math.max(largest, out / b.palm);
          if (when.length < 6) when.push(((b.t - t0) / 1000).toFixed(2));
        }
      }
    }
    rows.push([s, rate(n, triples), n ? f(largest, 2) : "-", when.join(" ") + (n > when.length ? " ..." : "")]);
  }
  table(rows);
}

function gaps({ doc }, trk) {
  heading("Thumb tip to index tip gap (landmarks 4 and 8)");
  const qs = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];
  const rows = [["hand", "unit", ...qs.map((q) => `p${Math.round(q * 100)}`)]];
  const raw = { L: [], R: [] };
  for (const s of SIDES) {
    const palm = [];
    for (const run of trk[s]) for (const x of run) {
      raw[s].push(x.gapRaw);
      if (Number.isFinite(x.gapPalm)) palm.push(x.gapPalm);
    }
    if (!raw[s].length) continue;
    rows.push([s, "raw", ...qs.map((q) => f(quantile(raw[s], q), 4))]);
    rows.push([s, "palm", ...qs.map((q) => f(quantile(palm, q), 3))]);
  }
  table(rows);
  const on = doc.params?.pinchOn, off = doc.params?.pinchOff;
  console.log(`\n  histogram, raw units${on !== undefined ? ` (pinchOn ${on}, pinchOff ${off} at recording time)` : ""}:`);
  const BIN = 0.01, BINS = 20;
  for (const s of SIDES) {
    if (!raw[s].length) continue;
    const hist = new Array(BINS + 1).fill(0);
    for (const v of raw[s]) hist[Math.min(BINS, Math.floor(v / BIN))]++;
    const top = Math.max(...hist);
    console.log(`  ${s}`);
    hist.forEach((n, k) => {
      const lo = (k * BIN).toFixed(2);
      const label = k === BINS ? `${lo}+    ` : `${lo}-${((k + 1) * BIN).toFixed(2)}`;
      const tag = [on, off].some((v) => v !== undefined && v >= k * BIN && v < (k + 1) * BIN) ? " <" : "";
      console.log(`    ${label} ${String(n).padStart(6)} ${"#".repeat(Math.round((40 * n) / top))}${tag}`);
    });
  }
}

function poses(trk) {
  heading("Pose measurements, recomputed from landmarks (see palm.ts)");
  const rows = [["hand", "measure", "p1", "p5", "p50", "p95", "p99"]];
  for (const s of SIDES) {
    for (const key of ["palm", "up", "len"]) {
      const v = [];
      for (const run of trk[s]) for (const x of run) v.push(x.pose[key]);
      if (v.length) rows.push([s, key, ...[0.01, 0.05, 0.5, 0.95, 0.99].map((q) => f(quantile(v, q), 3))]);
    }
  }
  table(rows);
}

function ramps({ marks }, trk) {
  if (!marks.length) return;
  heading(`Motion ramp at each mark (index knuckle, palm lengths; ms from the mark)`);
  console.log(`  moved: distance from where the hand was ${opt.pre} ms before the mark. lag: the ${opt.tau} s lagged-position signal.`);
  const LEVELS = [0.1, 0.25, 0.5];
  const reach = LEVELS.map(() => []);
  const idleMax = [];
  for (const m of marks) {
    const lines = [];
    const info = {};
    for (const s of SIDES) {
      const run = trk[s].find((r) => r[0].t <= m.at && r[r.length - 1].t >= m.at - opt.pre);
      if (!run) continue;
      const win = run.filter((x) => x.t >= m.at - opt.pre && x.t <= m.at + opt.post);
      if (win.length < 2) continue;
      const ref = win[0];
      const pts = win.map((x) => ({ ms: x.t - m.at, d: Math.hypot(x.kx - ref.kx, x.ky - ref.ky) / ref.palm, lag: x.lagK / x.palm }));
      info[s] = pts;
      const line = (key) => pts.map((p) => `${p.ms >= 0 ? "+" : ""}${p.ms.toFixed(0)}:${p[key].toFixed(2)}`).join("  ");
      lines.push(`    ${s} moved  ${line("d")}`, `    ${s} lag    ${line("lag")}`);
    }
    console.log(`  ${m.label}`);
    console.log(lines.length ? lines.join("\n") : "    (no continuous track around this mark)");
    const sides = Object.keys(info);
    if (sides.length === 0) continue;
    const peak = (s) => Math.max(...info[s].map((p) => p.d));
    const mover = sides.reduce((a, b) => (peak(b) > peak(a) ? b : a));
    LEVELS.forEach((lv, k) => {
      const hit = info[mover].find((p) => p.d >= lv);
      if (hit) reach[k].push(hit.ms);
    });
    for (const s of sides) if (s !== mover) idleMax.push(peak(s));
  }
  console.log("\n  Across marks, for the hand that moved further (ms relative to the mark; negative = before the key press):");
  table([
    ["moved", "marks reaching it", "median ms", "p10 ms", "p90 ms"],
    ...LEVELS.map((lv, k) => [`${lv} palm`, `${reach[k].length}/${marks.length}`, f(quantile(reach[k], 0.5), 0), f(quantile(reach[k], 0.1), 0), f(quantile(reach[k], 0.9), 0)]),
  ]);
  if (idleMax.length) {
    console.log(`  The other hand's largest move in the same window: median ${f(quantile(idleMax, 0.5), 2)} palm, p90 ${f(quantile(idleMax, 0.9), 2)}, max ${f(maxOf(idleMax), 2)}.`);
  }
  console.log("  The key press is not exact: read the shape of the ramp (palm lengths gained per frame), not its offset.");
}

// ---- main ------------------------------------------------------------------

for (const file of files) {
  const rec = load(file);
  console.log(`\n${"=".repeat(72)}\n${basename(file)}\n${"=".repeat(72)}`);
  if (rec.frames.length < 2) {
    console.log("  fewer than two rows: nothing to measure");
    continue;
  }
  const trk = tracks(rec.frames);
  for (const s of SIDES) for (const run of trk[s]) {
    lagMotion(run, "kx", "ky", "lagK");
    lagMotion(run, "cx", "cy", "lagC");
  }
  overview(rec);
  intervals(rec);
  reliability(rec);
  steadiness(rec, trk);
  jumps(trk);
  gaps(rec, trk);
  poses(trk);
  ramps(rec, trk);
}

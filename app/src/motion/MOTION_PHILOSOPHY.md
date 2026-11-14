# Motion Philosophy & Performance Contract

> Development guidance for all UI motion in this codebase. This is a binding
> philosophy doc, not a style suggestion. Spring physics is the motion
> primitive. The browser is shared with a computer-vision model on the main
> thread, so every motion decision is also a performance decision.

---

## 0. The one-paragraph version

Motion is spring-based, not duration-based. The character of a motion ("calm"
vs "alive" vs "sluggish") is governed by a single number, the damping ratio ζ,
not by a hand-tuned curve. For independent UI elements we use the **closed-form
analytic solution** of the damped harmonic oscillator (O(1), unconditionally
stable, no integrator), not a per-frame numerical loop. Because a CV model
shares the main thread, motion runs on one of two tracks: **interruptible
springs** (main thread, JS-driven, reserved for motion that must respond to
live input) and **pre-resolved springs** (sampled to keyframes and handed to
the compositor, immune to main-thread jank). Default to the second track. Only
pay for the first when interruption is a real requirement.

---

## 1. Why springs, not durations

A cubic-bézier easing is a fixed *shape* over a fixed *duration*. It is a
one-shot animation: it knows where it starts, where it ends, and how long it
takes. The moment a user interrupts it (clicks again, drags again, changes the
target mid-flight), a bézier has no graceful answer; restarting it produces a
visible discontinuity.

A spring is a *force model*, not a shape. It is defined by stiffness, damping,
and mass, and it responds to its current position and velocity. When the target
changes mid-motion, the spring carries its existing velocity into the new
trajectory. There is no discontinuity because there is nothing to restart;
there is only a force field and a moving object obeying it.

**Rule:** anything that can be interrupted, redirected, or driven by continuous
input (drag, gesture, scroll, sensor/CV-derived signal) is a spring. Springs
are the default primitive in this codebase. Béziers are permitted only for
strictly one-shot, non-interruptible transitions where a designer wants an
exact authored shape (e.g. a splash reveal that plays once).

This matters doubly here: an adaptive/ambient system whose motion responds to a
live signal is *by definition* interruptible. The signal changes; the target
moves; the motion must absorb that without restarting. That is the spring's
entire reason for existing.

---

## 2. The math we actually use

### 2.1 The model

A single UI spring is a damped harmonic oscillator:

```
m·x'' + c·x' + k·x = 0
```

where `k` = stiffness, `c` = damping, `m` = mass, `x` = displacement from
target.

### 2.2 The only number that controls "feel": the damping ratio ζ

```
ζ = c / (2·√(k·m))
ω₀ = √(k/m)        // natural (angular) frequency
```

- **ζ < 1 — underdamped.** Overshoots the target and oscillates before
  settling. This is the "alive / playful / springy" feeling. Most "delightful"
  UI sits around ζ ≈ 0.5–0.8.
- **ζ = 1 — critically damped.** The fastest possible approach to rest with
  **zero overshoot**. This is the "calm / luxurious / quiet-confidence"
  feeling. Use this as the default for premium, restraint-led surfaces.
- **ζ > 1 — overdamped.** Slow, sluggish, no overshoot. Reads as heavy or
  laggy. Avoid unless deliberately signalling weight.

> Design intent maps directly onto ζ. "Make it feel more premium" means push ζ
> toward 1.0. "Make it feel more playful" means lower ζ toward ~0.6. This is the
> single tunable that the rest of the system, including any adaptive layer,
> should reason about.

### 2.3 The closed-form solution (USE THIS by default)

The oscillator has an exact analytic solution. For initial displacement `x₀`
(position − target) and initial velocity `v₀`, evaluated at time `t` seconds:

```
Underdamped (ζ < 1):
  ω_d = ω₀·√(1 − ζ²)
  x(t) = e^(−ζω₀t) · [ x₀·cos(ω_d t) + ((v₀ + ζω₀x₀)/ω_d)·sin(ω_d t) ]

Critically damped (ζ = 1):
  x(t) = e^(−ω₀t) · [ x₀ + (v₀ + ω₀x₀)·t ]

Overdamped (ζ > 1):
  r = ω₀·√(ζ² − 1)
  a = −ζω₀ + r ; b = −ζω₀ − r
  x(t) = c₁·e^(a t) + c₂·e^(b t)     // c₁,c₂ from x₀,v₀
```

Position at the target is `target + x(t)`. Velocity is the analytic
derivative, available in closed form too, so interruption is exact: read
current `x` and `x'`, set them as the new `x₀`,`v₀`, retarget, done.

**Why analytic instead of an integrator:**

| Property                  | Analytic (closed form) | Numerical integrator |
|---------------------------|------------------------|----------------------|
| Cost per evaluation       | O(1), a few transcendentals | O(steps), per frame |
| Stability                 | Unconditional          | Conditional on dt / stiffness |
| Pre-sampling to keyframes | Trivial (evaluate at any t) | Requires running the sim |
| Interruption              | Exact (read x, x')     | Exact (read x, x')   |

For **independent** UI springs there is no reason to integrate. The integrator
question only arises when springs are **coupled** (a chain/mesh, e.g. list
items dragging each other, or a soft-body) or forces are **non-linear**. See
§2.4 only if you hit that case.

### 2.4 If (and only if) you need a numerical integrator

Coupled or non-linear systems have no clean closed form; integrate. Guidance
from the simulation literature:

- **Never use explicit (forward) Euler for springs.** It injects energy into
  the system and goes unstable for stiff springs; oscillation amplitude grows
  unphysically over time.
- **Default to semi-implicit (symplectic) Euler.** Update velocity first, then
  position with the *new* velocity. It conserves energy far better, is stable
  across a wide range, and is one line different from explicit Euler. This is
  the right default for nearly all coupled UI work.
- **Use RK4 only when you need accuracy and can afford it.** Fourth-order
  accurate, much costlier per step. Rarely justified for UI; it maintains
  correct frequency but can still lose energy. Reserve for offline/precompute.
- **Implicit (backward) Euler for very stiff systems.** Unconditionally stable
  but heavily damped (loses energy / kills oscillation) and requires solving a
  system per step. Use when stiffness would otherwise force an impractically
  small timestep.
- **Always use a fixed timestep with an accumulator.** Never integrate with the
  raw frame delta; a long frame (caused by the CV model blocking) would take a
  huge unstable step. Accumulate real elapsed time and consume it in fixed
  sub-steps (e.g. fixed 1/120 s), interpolating the remainder for display.

---

## 3. The performance contract (shared main thread with CV)

This is the constraint that shapes the architecture. A CV model and its JS glue
contend for the **main thread**. Spring animation driven by
`requestAnimationFrame` *also* runs on the main thread. If the CV model blocks
the main thread for even one long task, every rAF-driven animation drops frames
simultaneously. The browser's compositor thread, which keeps `transform` /
`opacity` / `filter` smooth, **cannot run JavaScript and cannot be reached
imperatively from a worker**; you can only *declare* an animation in a way that
lets the browser offload it.

So we cannot "just run the spring on the compositor." A live, interruptible
spring is inherently JS. The resolution is a two-track model.

### Track A — Pre-resolved springs (DEFAULT)

For any spring whose target is known at trigger time and that does **not** need
to react to input mid-flight:

1. Compute the spring's full trajectory analytically (§2.3).
2. Sample it into keyframes (e.g. every ~16 ms up to the settle time).
3. Hand those keyframes to the **Web Animations API** (WAAPI), animating only
   compositor-friendly properties (`transform`, `opacity`).
4. The compositor runs it. **It stays smooth even if the CV model pins the main
   thread**, because no per-frame JS is involved.

This is the workhorse. Entrances, exits, state changes, layout reveals, almost
everything, is Track A. The spring physics gives the *feel*; the compositor
gives the *immunity to jank*. We get both.

```
// shape, not literal API
const samples = sampleSpring({ stiffness, damping, mass, from, to }); // analytic
element.animate(
  samples.map(s => ({ transform: `translateX(${s}px)` })),
  { duration: settleMs, easing: "linear", fill: "forwards" }
);
```

### Track B — Live interruptible springs (PAY ONLY WHEN NEEDED)

For motion that must respond to continuous live input (drag, gesture, a
CV/sensor-derived target that updates every frame), there is no avoiding
main-thread JS. Minimize the cost:

- Animate **only** `transform` and `opacity`. Never animate layout-triggering
  properties (`width`, `height`, `top`, `left`, `margin`); they force layout +
  paint on the main thread every frame. <see §4>
- Use **one** central rAF loop (a single ticker) that advances every live
  spring, not one rAF per element. Batch all reads, then all writes, to avoid
  layout thrashing.
- Keep the per-frame work trivial: the analytic solution is a handful of
  transcendentals per spring; that is affordable. The danger is never the
  spring math, it is the DOM writes and any accidental layout.
- Set `will-change: transform` on elements that are actively in live motion,
  and **remove it when they settle** (a permanent `will-change` wastes GPU
  memory).

### The decision rule

```
Does this motion need to react to input AFTER it starts?
  NO  → Track A. Pre-resolve to keyframes, give to compositor. (default)
  YES → Track B. Single rAF ticker, transform/opacity only, drop will-change on settle.
```

When unsure, it's Track A. Most motion that *feels* interruptible (a panel
opening) is actually one-shot; true interruption (a drag) is rarer than it
seems.

---

## 4. Non-negotiable browser performance rules

These hold regardless of track and regardless of motion model.

1. **Only animate `transform`, `opacity`, `filter`, `clip-path`.** These can be
   composited without layout or paint. Animating `width`/`height`/`top`/`left`/
   `margin`/`padding` forces a layout recalculation on the main thread every
   frame, the single most common cause of jank, and is strictly forbidden for
   animation. Animate `transform: scale()` instead of `width`,
   `transform: translate()` instead of `top`/`left`.
2. **Target 60 fps = a 16.6 ms frame budget**, shared with the CV model. If the
   CV model needs the main thread, the *only* way the animation survives is
   Track A (compositor). This is why Track A is the default.
3. **Get the CV model off the main thread wherever possible.** Run inference in
   a Web Worker, or on GPU via WebGPU/WebGL. The less the CV model touches the
   main thread, the more headroom Track B has. (This doc can't move the model,
   but every motion decision assumes the main thread is contended.)
4. **One ticker, batched reads/writes.** A central rAF loop for all live
   motion. Read all DOM/layout values first, then write all of them. Never
   interleave read→write→read→write (layout thrashing).
5. **`will-change` is a scalpel, not a default.** Apply it just before a live
   animation, remove it on settle. Promoting everything permanently exhausts
   GPU memory and can *degrade* performance.
6. **Stop the loop when nothing is moving.** When all springs report settled
   (mechanical energy below a small epsilon: both displacement and velocity
   near zero), cancel the rAF loop entirely. A spinning idle rAF steals frames
   from the CV model for no reason. Restart on the next interaction.
7. **Respect `prefers-reduced-motion`.** When set, skip the trajectory and jump
   to the resolved end state (or cross-fade). This is an accessibility
   requirement, not an enhancement; vestibular disorders make large or springy
   motion genuinely harmful.
8. **Measure, don't guess.** Jank is invisible until profiled. Use the
   browser's performance trace; watch for long tasks and dropped frames,
   especially during CV-heavy phases. A motion that's smooth in isolation can
   die under inference load.

---

## 5. Energy / settle detection (when to stop)

A spring never mathematically reaches rest; it asymptotes. Define "settled" as:

```
settled  ⇔  |displacement| < ε_x   AND   |velocity| < ε_v
```

with small epsilons in the units of the animated property. On settle:

- Snap to the exact target (kill sub-pixel residue).
- Remove `will-change`.
- If no other spring is active, stop the rAF ticker.

For Track A, the settle time is computed up front (the envelope `e^(−ζω₀t)`
falling below a threshold) and used as the keyframe animation's duration.

---

## 6. Defaults to start from

A small, named palette of springs, referenced by intent, not by raw numbers.
Tune to taste, but keep the set *small*; a coherent motion identity comes from
reusing a few springs everywhere, not from per-element bespoke values.

| Token       | ζ (approx) | Feel                         | Use for                          |
|-------------|------------|------------------------------|----------------------------------|
| `calm`      | ~1.0       | no overshoot, settled        | premium reveals, default surfaces|
| `responsive`| ~0.85      | barely-there overshoot       | buttons, toggles, feedback       |
| `lively`    | ~0.6       | clear overshoot, playful     | accents, celebratory moments     |
| `heavy`     | ~1.2       | slow, weighted, no overshoot | large containers, modal scrims   |

Express these as (stiffness, damping, mass) triples in one central module.
Everything else imports from there. One source of truth for motion feel.

---

## 7. The adaptive angle (forward-looking)

Because feel collapses to a tiny parameter set, motion is a low-dimensional,
fully-parameterized, *verifiable* representation: per spring, essentially
(stiffness, damping, mass), and the character is dominated by ζ alone. An
adaptive layer that personalizes motion is therefore tuning ~1–3 continuous
numbers per token against a measurable signal (does the user keep it, retune
it, exhibit friction), with the rendered result as ground truth. That is the
verifiable Code → Render → Inspect → Revise loop applied to motion. Keep the
motion system expressed as data (the token triples), never as hard-coded
per-element values, so an adaptive layer has a clean surface to act on later.
This does not require building the adaptive layer now; it requires not
foreclosing it.

---

## 8. Checklist for any new motion

- [ ] Is it a spring? (If interruptible/input-driven: it must be.)
- [ ] Does it use a named token from §6, not bespoke numbers?
- [ ] Track A (pre-resolved → compositor) unless it needs live interruption?
- [ ] Only `transform` / `opacity` / `filter` / `clip-path` animated?
- [ ] On the single central ticker (if Track B)? Reads/writes batched?
- [ ] `will-change` added on start and removed on settle?
- [ ] Ticker stops when all springs settle?
- [ ] `prefers-reduced-motion` jumps to end state?
- [ ] Profiled under CV-inference load, not just in isolation?

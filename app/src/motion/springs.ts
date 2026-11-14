// Spring motion as data. See MOTION_PHILOSOPHY.md (this folder).
//
// Feel collapses to the damping ratio zeta and natural frequency omega. We keep
// a small named palette (tokens by intent) and evaluate the damped harmonic
// oscillator in closed form (analytic, O(1), unconditionally stable) for
// independent motions like entrances. Coupled motion (the graph layout) is left
// to the force integrator; only its damping is exposed here as data.

export interface Spring {
  zeta: number; // damping ratio: <1 overshoot, =1 critical, >1 sluggish
  omega: number; // natural angular frequency (rad/s)
}

// Higher omega = faster settle. Tuned for a snappy UI, not a heavy one.
export const SPRINGS = {
  calm: { zeta: 1.0, omega: 24 }, // premium reveals, panel, zoom; no overshoot
  responsive: { zeta: 0.9, omega: 48 }, // hover/selection; fast feedback
  lively: { zeta: 0.6, omega: 34 }, // playful accents
  heavy: { zeta: 1.2, omega: 18 }, // large containers
} satisfies Record<string, Spring>;

export type SpringToken = keyof typeof SPRINGS;

// Layout (coupled, integrator-driven) damping, expressed as data so feel lives
// in one place rather than as a magic number in the view.
export const LAYOUT = { velocityDecay: 0.45 };

// Displacement from target at time t (s), given initial displacement x0 and
// velocity v0. Closed-form solution of m*x'' + c*x' + k*x = 0.
export function springDisplacement(s: Spring, t: number, x0: number, v0 = 0): number {
  const { zeta, omega } = s;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const a = x0;
    const b = (v0 + zeta * omega * x0) / wd;
    return Math.exp(-zeta * omega * t) * (a * Math.cos(wd * t) + b * Math.sin(wd * t));
  }
  if (zeta === 1) {
    return Math.exp(-omega * t) * (x0 + (v0 + omega * x0) * t);
  }
  const r = omega * Math.sqrt(zeta * zeta - 1);
  const a = -zeta * omega + r;
  const b = -zeta * omega - r;
  const c1 = (v0 - b * x0) / (a - b);
  const c2 = x0 - c1;
  return c1 * Math.exp(a * t) + c2 * Math.exp(b * t);
}

// Normalized progress toward target over time, starting from rest at 0. Returns
// 0 at t=0 and approaches 1; underdamped tokens briefly overshoot past 1.
export function springProgress(token: SpringToken, t: number): number {
  return 1 - springDisplacement(SPRINGS[token], t, 1, 0);
}

// Time (s) at which the decay envelope falls below eps: the settle time.
export function springSettleTime(token: SpringToken, eps = 0.01): number {
  const { zeta, omega } = SPRINGS[token];
  return Math.log(1 / eps) / (zeta * omega);
}

export function springDurationMs(token: SpringToken): number {
  return springSettleTime(token) * 1000;
}

// Build a critically-damped spring (no overshoot) whose settle time equals the
// given ms. Lets a one-off timing, e.g. a hover dwell, drive a spring from the
// same number without minting a bespoke token. eps mirrors springSettleTime.
export function springForSettleMs(ms: number, zeta = 1, eps = 0.01): Spring {
  const omega = Math.log(1 / eps) / (zeta * (ms / 1000));
  return { zeta, omega };
}

// Pre-resolve a 0->1 entrance spring to evenly-spaced keyframe progress values,
// for Track A (hand to the compositor via WAAPI). See MOTION_PHILOSOPHY section 3.
export function sampleSpring(token: SpringToken, stepMs = 16): number[] {
  const settle = springSettleTime(token);
  const n = Math.max(2, Math.ceil((settle * 1000) / stepMs));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(springProgress(token, (i / n) * settle));
  out[out.length - 1] = 1; // land exactly on target
  return out;
}

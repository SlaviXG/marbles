// A damped spring, evaluated in closed form (analytic, O(1), unconditionally
// stable). The cursor driver uses it to carry the tracked fingertip, which
// arrives at inference rate, up to display rate. Kept inside the library so it
// has no dependencies; time is always passed in, never read from a clock, so a
// recorded session replays identically.

export interface Spring {
  zeta: number; // damping ratio: <1 overshoot, =1 critical, >1 sluggish
  omega: number; // natural angular frequency (rad/s)
}

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

// A critically damped spring (no overshoot) that settles within `ms`.
export function springForSettleMs(ms: number, zeta = 1, eps = 0.01): Spring {
  const omega = Math.log(1 / eps) / (zeta * (ms / 1000));
  return { zeta, omega };
}

// An interruptible scalar spring. Retargeting mid-flight carries the current
// value and velocity into the new trajectory, so there is no restart jump.
// All times are seconds on the caller's clock.
export class SpringValue {
  private target: number;
  private x0 = 0; // displacement from target at t0
  private v0 = 0; // velocity at t0
  private t0: number;
  value: number;
  velocity = 0;

  constructor(
    private readonly spring: Spring,
    initial: number,
    now: number,
  ) {
    this.value = initial;
    this.target = initial;
    this.t0 = now;
  }

  setTarget(target: number, now: number) {
    if (target === this.target) return;
    this.x0 = this.value - target;
    this.v0 = this.velocity;
    this.target = target;
    this.t0 = now;
  }

  // Advance to `now`; returns true once settled (at rest on target).
  update(now: number): boolean {
    const t = now - this.t0;
    const disp = springDisplacement(this.spring, t, this.x0, this.v0);
    const dt = 1 / 240;
    const disp2 = springDisplacement(this.spring, t + dt, this.x0, this.v0);
    this.velocity = (disp2 - disp) / dt;
    this.value = this.target + disp;
    if (Math.abs(disp) < 1e-3 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}

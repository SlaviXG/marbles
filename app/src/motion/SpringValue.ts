import { SPRINGS, springDisplacement, type Spring, type SpringToken } from "./springs";

// An interruptible scalar spring (MOTION_PHILOSOPHY section 1). Retargeting
// mid-flight carries the current value and velocity into the new trajectory, so
// there is no restart discontinuity. Evaluated in closed form (analytic, O(1)).
export class SpringValue {
  private spring: Spring;
  private target: number;
  private x0 = 0; // displacement from target at t0
  private v0 = 0; // velocity at t0
  private t0: number;
  value: number;
  velocity = 0;

  constructor(spring: SpringToken | Spring, initial = 0) {
    this.spring = typeof spring === "string" ? SPRINGS[spring] : spring;
    this.value = initial;
    this.target = initial;
    this.t0 = performance.now() / 1000;
  }

  // Where it is heading, for callers that retarget RELATIVE to the goal rather
  // than to the current value. Nudging repeatedly (a gesture arriving in small
  // steps) must accumulate against the goal; adding each delta to the lagging
  // `value` instead would keep re-aiming at where the spring has got to so far,
  // and the motion would fall progressively short of the input.
  get goal(): number {
    return this.target;
  }

  setTarget(target: number, velocity: number = this.velocity) {
    if (target === this.target && velocity === this.velocity) return;
    this.x0 = this.value - target;
    this.v0 = velocity;
    this.velocity = velocity;
    this.target = target;
    this.t0 = performance.now() / 1000;
  }

  // Jump to a value at rest (resets the trajectory so update() holds it there).
  jump(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.x0 = 0;
    this.v0 = 0;
    this.t0 = performance.now() / 1000;
  }

  // Translate value and target together, preserving any in-flight trajectory.
  shift(delta: number) {
    this.value += delta;
    this.target += delta;
  }

  // Advance to the given time; returns true once settled (at rest on target).
  update(now = performance.now() / 1000): boolean {
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

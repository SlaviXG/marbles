// Head pose from MediaPipe's facial transformation matrix, and the decision
// "is this person looking at the screen?".
//
// The matrix is 4x4, column-major, mapping the canonical face (looking straight
// down the camera's axis) to where the face actually is. Its third column is
// therefore the direction the face points; yaw and pitch fall out of it.
export type HeadPose = { yaw: number; pitch: number };
export type Face = { matrix: ArrayLike<number>; size: number };

const DEG = 180 / Math.PI;
export function poseFromMatrix(m: ArrayLike<number>): HeadPose {
  const x = m[8], y = m[9], z = m[10];
  const length = Math.hypot(x, y, z) || 1;
  return { yaw: Math.atan2(x, z) * DEG, pitch: Math.asin(Math.max(-1, Math.min(1, -y / length))) * DEG };
}

/** The person to pay attention to: the nearest face, which is the largest one in view. */
export function closestFace<T extends { size: number }>(faces: T[]): T | null {
  return faces.reduce<T | null>((best, face) => (!best || face.size > best.size ? face : best), null);
}

export const ATTENTION = {
  yaw: 24, // degrees either side of straight ahead
  pitch: 22, // degrees up or down (a laptop screen sits just below its camera)
  release: 1.25, // once looking, the cone is this much wider, so a nod does not drop it
  engageMs: 300, // looking must hold this long to count
  awayMs: 1400, // ...and looking away this long to stop counting
  goneMs: 2000, // no face at all for this long: nobody is there
};

export const facing = (pose: HeadPose, widen = 1) => Math.abs(pose.yaw) <= ATTENTION.yaw * widen && Math.abs(pose.pitch) <= ATTENTION.pitch * widen;

export type Attention = 'looking' | 'away' | 'nobody';
/** Turns per-frame poses into a steady answer, with hysteresis in angle and in time. */
export class AttentionFilter {
  state: Attention = 'nobody';
  private since = -1; // when the current disagreement with `state` began (-1: none)
  private lastFace = -Infinity;
  update(now: number, pose: HeadPose | null): Attention {
    if (pose) this.lastFace = now;
    const raw: Attention = !pose ? (now - this.lastFace >= ATTENTION.goneMs ? 'nobody' : this.state === 'looking' ? 'away' : this.state)
      : facing(pose, this.state === 'looking' ? ATTENTION.release : 1) ? 'looking' : 'away';
    if (raw === this.state) { this.since = -1; return this.state; }
    if (this.since < 0) this.since = now;
    const hold = raw === 'looking' ? ATTENTION.engageMs : raw === 'away' ? ATTENTION.awayMs : 0;
    if (now - this.since >= hold) { this.state = raw; this.since = -1; }
    return this.state;
  }
}

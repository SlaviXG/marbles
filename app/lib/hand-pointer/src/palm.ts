// Which side of the hand the camera sees: the palm or the back.
//
// Only a hand held palm-out is treated as input. A hand seen from the back is
// someone scratching their head, holding a cup or resting on the desk, and
// running pinch detection on it produces clicks nobody meant.
//
// Method: the wrist (0), index knuckle (5) and pinky knuckle (17) form a rigid
// triangle on the palm, unaffected by how the fingers are bent. Seen from the
// front its corners run one way round, seen from the back the other, so the
// sign of the 2D cross product of wrist->index and wrist->pinky says which
// side is showing. Which sign means "palm" depends on whether it is a left or
// a right hand, since the two are mirror images.
//
// The cross product is divided by both lengths, giving the sine of the angle
// at the wrist: about +0.6 for a flat palm, about -0.6 for the back, and near
// 0 when the hand is edge-on, whatever its distance from the camera. In-plane
// rotation does not change it, so a tilted or sideways hand reads the same.
//
// Two more poses are rejected the same way, because gestures read from them
// are just as unreliable (see handPose below): a hand that is not upright
// (wrist level with or above the knuckles), and a hand tipped forward so its
// fingers point at the camera.

const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

// The sign of the cross product for a RIGHT hand showing its palm, in the raw
// (unmirrored) camera frame with y pointing down. With the palm toward the
// camera the thumb side of a right hand is at larger x than the pinky side,
// which makes the cross product negative. This is the single thing to flip if
// palm and back ever read the wrong way round (for instance if the handedness
// labels are swapped on another camera or MediaPipe version).
const RIGHT_PALM_SIGN = -1;

// pts: the 21 landmarks, flat [x0,y0,x1,y1,...] in normalized frame coords.
// aspect: frame width / height. Normalized coords stretch x and y by different
// amounts on a non-square frame, which would distort every angle and length
// measured here, so x is scaled back before measuring.
// Returns a score in -1..1: positive when the palm faces the camera, negative
// for the back of the hand, near zero when the hand is edge-on.
export function palmFacing(pts: number[], hand: "L" | "R", aspect = 1): number {
  const ax = (pts[INDEX_MCP * 2] - pts[WRIST * 2]) * aspect;
  const ay = pts[INDEX_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const bx = (pts[PINKY_MCP * 2] - pts[WRIST * 2]) * aspect;
  const by = pts[PINKY_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const len = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (!(len > 1e-9)) return 0;
  const sine = (ax * by - ay * bx) / len;
  return sine * RIGHT_PALM_SIGN * (hand === "R" ? 1 : -1);
}

// How upright the hand is: the cosine of the angle between "straight up" and
// the line from the wrist to the middle knuckle. 1 with the fingers pointing
// straight up, 0 with the wrist level with the knuckles (hand lying sideways),
// negative with the wrist above them (hand hanging down).
export function fingersUp(pts: number[], aspect = 1): number {
  const dx = (pts[MIDDLE_MCP * 2] - pts[WRIST * 2]) * aspect;
  const dy = pts[MIDDLE_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return 0;
  return -dy / len; // image y grows downward
}

// How much of the palm's length the camera sees: wrist-to-middle-knuckle
// distance divided by the width across the knuckles (index to pinky). About
// 1.4 for a hand held flat to the camera. Tipping the hand forward, so the
// fingers point at the lens, shortens the length but not the width, so the
// ratio falls with the cosine of the tilt and reaches 0 when the fingers point
// straight at the camera. A ratio is used so distance from the camera cancels.
export function palmLength(pts: number[], aspect = 1): number {
  const lx = (pts[MIDDLE_MCP * 2] - pts[WRIST * 2]) * aspect;
  const ly = pts[MIDDLE_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const wx = (pts[PINKY_MCP * 2] - pts[INDEX_MCP * 2]) * aspect;
  const wy = pts[PINKY_MCP * 2 + 1] - pts[INDEX_MCP * 2 + 1];
  const width = Math.hypot(wx, wy);
  if (!(width > 1e-9)) return 0;
  return Math.hypot(lx, ly) / width;
}

// The three measurements together. A hand is used as input only when all
// three say it is held up, square to the camera, palm out.
export interface HandPose {
  palm: number; // palmFacing
  up: number; // fingersUp
  len: number; // palmLength
}

export function handPose(pts: number[], hand: "L" | "R", aspect = 1): HandPose {
  return {
    palm: palmFacing(pts, hand, aspect),
    up: fingersUp(pts, aspect),
    len: palmLength(pts, aspect),
  };
}

// Each measurement has an ON threshold a hand must exceed to start counting
// and a lower OFF threshold it must fall below to stop. The gap is hysteresis,
// so a hand held near a limit does not flicker in and out of use.
//
// Palm: a hand turned sideways is rejected along with one seen from the back.
// Near edge-on the fingers overlap in the image and the landmarks are
// unreliable. The score falls as the hand turns: with a flat palm at about 0.6,
// 0.4 is about 55 degrees away from facing the camera and 0.3 about 65 (the
// conversion is in the README, under "Estimating the thresholds").
export const PALM_ON = 0.4;
export const PALM_OFF = 0.3;
// Upright: fingers within 60 degrees of straight up to start, 70 to stop. A
// hand lying level (0) or hanging down (negative) never counts.
export const UP_ON = 0.5;
export const UP_OFF = 0.35;
// Tilt toward the camera: with a flat hand at about 1.4, 0.9 is about 50
// degrees of forward tilt and 0.75 about 58.
export const LEN_ON = 0.9;
export const LEN_OFF = 0.75;

// was: whether this hand counted on the previous frame.
export function poseUsable(p: HandPose, was: boolean): boolean {
  return was
    ? p.palm > PALM_OFF && p.up > UP_OFF && p.len > LEN_OFF
    : p.palm > PALM_ON && p.up > UP_ON && p.len > LEN_ON;
}

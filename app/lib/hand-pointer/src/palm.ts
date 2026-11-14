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
// One more pose is rejected: a hand turned down, with all its fingers below
// the wrist (see fingersUp). A hand tipped forward so its fingers point at the
// camera is NOT rejected, as long as its fingers are above the wrist: that is
// how a hand looks with the camera below it, and how many people point.

const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
// Middle joints of the four fingers (index, middle, ring, pinky).
const FINGER_PIPS = [6, 10, 14, 18];

// A flat hand's palm length (wrist to middle knuckle) over its width across
// the knuckles. Used to undo the squash of a hand tipped toward the camera.
const FLAT_LEN = 1.4;
// The most the palm triangle is stretched back. 6x restores a palm seen at
// about 80 degrees of forward tilt; beyond that the triangle has collapsed
// into a line and its shape says nothing reliable.
const MAX_STRETCH = 6;

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
//
// A hand tipped toward the camera (fingers pointing at the lens) squashes the
// palm triangle along its length: the knuckles close in on the wrist, the
// angle at the wrist opens out, and the sine falls toward 0 even though the
// palm still faces the camera. Left alone that would reject such a hand as if
// it were edge-on. So when the palm looks shorter than a flat palm, the
// triangle is first stretched back along its length (perpendicular to the
// knuckle line) to a flat palm's proportions. Turning the hand sideways
// narrows the knuckle line instead, which makes the palm look LONGER, so no
// stretch applies and the score still falls as the hand turns. The stretch
// keeps the triangle's winding, so palm and back still read correctly.
export function palmFacing(pts: number[], hand: "L" | "R", aspect = 1): number {
  let ax = (pts[INDEX_MCP * 2] - pts[WRIST * 2]) * aspect;
  let ay = pts[INDEX_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  let bx = (pts[PINKY_MCP * 2] - pts[WRIST * 2]) * aspect;
  let by = pts[PINKY_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const wx = bx - ax; // knuckle line, index to pinky
  const wy = by - ay;
  const width = Math.hypot(wx, wy);
  const length = Math.hypot(
    (pts[MIDDLE_MCP * 2] - pts[WRIST * 2]) * aspect,
    pts[MIDDLE_MCP * 2 + 1] - pts[WRIST * 2 + 1],
  );
  if (width > 1e-9 && length < FLAT_LEN * width) {
    const k = Math.min(MAX_STRETCH, (FLAT_LEN * width) / Math.max(length, 1e-9));
    // Unit vector across the knuckle line; scale the component along it.
    const nx = -wy / width;
    const ny = wx / width;
    const ca = (ax * nx + ay * ny) * (k - 1);
    const cb = (bx * nx + by * ny) * (k - 1);
    ax += ca * nx;
    ay += ca * ny;
    bx += cb * nx;
    by += cb * ny;
  }
  const len = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (!(len > 1e-9)) return 0;
  const sine = (ax * by - ay * bx) / len;
  return sine * RIGHT_PALM_SIGN * (hand === "R" ? 1 : -1);
}

// Whether the hand is held up or turned down: how far the highest of the four
// finger middle joints (PIP: landmarks 6, 10, 14, 18) sits above the wrist, in
// knuckle widths (index to pinky knuckle). Positive while at least one of them
// is above the wrist; negative once all four have dropped below it, which is
// what "turned down" means here. Knuckle width rather than palm length,
// because tipping the hand toward the camera shortens the palm but not the
// knuckle line, and dividing by a shrinking length would blow the value up.
//
// This replaced an angle test (the wrist-to-knuckle line against vertical),
// which failed with the camera below the hand: seen from underneath, an
// upright hand is foreshortened and its knuckles can read level with the
// wrist, so a hand held normally was thrown out. Whether the fingers are above
// the wrist at all survives that viewpoint. A hand lying sideways now counts,
// since its upper fingers are still above the wrist.
export function fingersUp(pts: number[], aspect = 1): number {
  const wy = pts[WRIST * 2 + 1];
  let top = Infinity;
  for (const i of FINGER_PIPS) top = Math.min(top, pts[i * 2 + 1]);
  const width = Math.hypot(
    (pts[PINKY_MCP * 2] - pts[INDEX_MCP * 2]) * aspect,
    pts[PINKY_MCP * 2 + 1] - pts[INDEX_MCP * 2 + 1],
  );
  if (!(width > 1e-9) || !Number.isFinite(top)) return 0;
  return (wy - top) / width; // image y grows downward
}

// How much of the palm's length the camera sees: wrist-to-middle-knuckle
// distance divided by the width across the knuckles (index to pinky). About
// 1.4 for a hand held flat to the camera. Tipping the hand forward, so the
// fingers point at the lens, shortens the length but not the width, so the
// ratio falls with the cosine of the tilt and reaches 0 when the fingers point
// straight at the camera. A ratio is used so distance from the camera cancels.
//
// Informational only: it used to reject hands tipped toward the camera, but a
// hand seen from a camera below it looks exactly like that, so it no longer
// gates anything. It is still reported for the overlay and recordings.
export function palmLength(pts: number[], aspect = 1): number {
  const lx = (pts[MIDDLE_MCP * 2] - pts[WRIST * 2]) * aspect;
  const ly = pts[MIDDLE_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const wx = (pts[PINKY_MCP * 2] - pts[INDEX_MCP * 2]) * aspect;
  const wy = pts[PINKY_MCP * 2 + 1] - pts[INDEX_MCP * 2 + 1];
  const width = Math.hypot(wx, wy);
  if (!(width > 1e-9)) return 0;
  return Math.hypot(lx, ly) / width;
}

// The measurements together. A hand is used as input when its palm faces the
// camera and its fingers are above the wrist; `len` is reported, not gated.
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
// Upright: a hand stops counting once all four finger middle joints are
// below the wrist (OFF 0), and must lift one at least a tenth of a knuckle
// width above it to count again (ON), so a hand held near level does not
// flicker.
export const UP_ON = 0.1;
export const UP_OFF = 0;

// was: whether this hand counted on the previous frame.
export function poseUsable(p: HandPose, was: boolean): boolean {
  return was ? p.palm > PALM_OFF && p.up > UP_OFF : p.palm > PALM_ON && p.up > UP_ON;
}

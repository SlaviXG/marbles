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

const WRIST = 0;
const INDEX_MCP = 5;
const PINKY_MCP = 17;

// The sign of the cross product for a RIGHT hand showing its palm, in the raw
// (unmirrored) camera frame with y pointing down. With the palm toward the
// camera the thumb side of a right hand is at larger x than the pinky side,
// which makes the cross product negative. This is the single thing to flip if
// palm and back ever read the wrong way round (for instance if the handedness
// labels are swapped on another camera or MediaPipe version).
const RIGHT_PALM_SIGN = -1;

// pts: the 21 landmarks, flat [x0,y0,x1,y1,...] in normalized frame coords.
// Returns a score in -1..1: positive when the palm faces the camera, negative
// for the back of the hand, near zero when the hand is edge-on.
export function palmFacing(pts: number[], hand: "L" | "R"): number {
  const ax = pts[INDEX_MCP * 2] - pts[WRIST * 2];
  const ay = pts[INDEX_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const bx = pts[PINKY_MCP * 2] - pts[WRIST * 2];
  const by = pts[PINKY_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  const len = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (!(len > 1e-9)) return 0;
  const sine = (ax * by - ay * bx) / len;
  return sine * RIGHT_PALM_SIGN * (hand === "R" ? 1 : -1);
}

// A hand turned sideways is rejected along with one seen from the back. Near
// edge-on the fingers overlap in the image and the landmarks are unreliable,
// so a pinch read from that pose is mostly noise.
//
// With a flat palm scoring about 0.6, the score falls roughly with the cosine
// of how far the hand has turned: 0.4 is about 55 degrees away from facing the
// camera and 0.3 about 65 degrees. So a hand must be within about 55 degrees
// of square-on to start counting, and stops counting past about 65.
//
// The gap between the two is hysteresis, so a hand held near the limit does
// not flicker in and out of use.
export const PALM_ON = 0.4;
export const PALM_OFF = 0.3;

export function palmOpen(score: number, was: boolean): boolean {
  return was ? score > PALM_OFF : score > PALM_ON;
}

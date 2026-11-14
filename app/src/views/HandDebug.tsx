import { useEffect, useRef } from "react";
import { subscribeFrame } from "../motion/ticker";
import {
  handDebug,
  LEN_OFF,
  MOVE,
  PALM_OFF,
  UP_OFF,
  loadParams,
  subscribeParams,
  usePointerStore,
  type PointerParams,
} from "../input";

// Diagnostic overlay for hand tracking: a small picture of CAMERA space, not
// screen space. That is the point of it. Screen space only shows where the
// cursor ended up; camera space also shows how the hand sits in frame, whether
// it has drifted outside the active zone (the mapped sub-rectangle), and which
// hand MediaPipe thinks it is looking at. All three are the things that actually
// go wrong, and none of them are visible from the cursor alone.
//
// Drawn on the shared ticker but only when a new inference result has landed
// (handDebug.version), so a still hand costs one integer comparison per frame
// rather than a repaint. Inference runs ~15fps; the display runs far faster.

// MediaPipe's 21-landmark topology: palm, then thumb and four fingers.
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const W = 176;
const H = 132; // 4:3, the camera's aspect

export default function HandDebug() {
  const on = usePointerStore((s) => s.debug);
  const tracking = usePointerStore((s) => s.status === "tracking");
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!on || !tracking) return;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let params: PointerParams = loadParams();
    const unsubParams = subscribeParams((p) => {
      params = p;
    });
    let drawn = -1;

    const unsub = subscribeFrame(() => {
      if (handDebug.version === drawn) return;
      drawn = handDebug.version;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(9, 12, 17, 0.92)";
      ctx.fillRect(0, 0, W, H);

      // The active zone: the part of the frame that maps to the whole screen.
      // Drawn in mirrored space, same as the landmarks below, so the two agree.
      const zx = params.zoneX0 * W;
      const zy = params.zoneY0 * H;
      const zw = (params.zoneX1 - params.zoneX0) * W;
      const zh = (params.zoneY1 - params.zoneY0) * H;
      ctx.strokeStyle = "rgba(140, 160, 210, 0.35)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(zx, zy, zw, zh);
      ctx.setLineDash([]);

      let readouts = 0;
      for (const h of handDebug.hands) {
        const pts = h.pts;
        // Mirror x to match the selfie view the user is looking at; the cursor
        // mapping does the same before the zone transform.
        const px = (i: number) => (1 - pts[i * 2]) * W;
        const py = (i: number) => pts[i * 2 + 1] * H;

        // A hand that failed the palm gate (seen from the back) is drawn dim
        // red: tracked, but not used as input.
        const accent = !h.active
          ? "rgba(248, 113, 113, 0.75)"
          : h.primary
            ? "rgba(45, 212, 191, 1)"
            : "rgba(140, 160, 210, 0.75)";
        ctx.strokeStyle = !h.active
          ? "rgba(248, 113, 113, 0.45)"
          : h.primary
            ? "rgba(45, 212, 191, 0.75)"
            : "rgba(140, 160, 210, 0.45)";
        ctx.lineWidth = h.primary ? 1.5 : 1;
        ctx.beginPath();
        for (const [a, b] of BONES) {
          ctx.moveTo(px(a), py(a));
          ctx.lineTo(px(b), py(b));
        }
        ctx.stroke();

        ctx.fillStyle = accent;
        for (let i = 0; i < pts.length / 2; i++) {
          ctx.beginPath();
          ctx.arc(px(i), py(i), i === 8 || i === 4 ? 2.6 : 1.4, 0, Math.PI * 2);
          ctx.fill();
        }

        // The measured pair: thumb-to-index is the pinch, the one press
        // gesture. Lights up once it is past its threshold.
        //
        // Computed in NORMALISED frame coords, not the canvas pixels px()/py()
        // return: those are mirrored and scaled by W and H separately, which
        // distorts the aspect and would not match what cameraPointer thresholds
        // on. Same maths as there, so the numbers shown are the real ones.
        const nx = (i: number) => pts[i * 2];
        const ny = (i: number) => pts[i * 2 + 1];
        const d = (a: number, b: number) => Math.hypot(nx(a) - nx(b), ny(a) - ny(b));
        const pinch = d(4, 8);

        const hot = (live: boolean) => (live ? "rgba(45, 212, 191, 1)" : "rgba(140, 160, 210, 0.5)");
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = hot(pinch < params.pinchOn);
        ctx.beginPath();
        ctx.moveTo(px(4), py(4));
        ctx.lineTo(px(8), py(8));
        ctx.stroke();

        ctx.fillStyle = accent;
        ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(h.hand + (h.primary ? " ·" : ""), px(0) - 4, py(0) + 14);

        // Numeric readout, one row per hand: the raw distance the press gesture
        // thresholds on, and how fast the hand is changing shape.
        const row = H - 6 - readouts * 11;
        readouts++;
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillStyle = "rgba(139, 148, 158, 0.9)";
        ctx.fillText(`${h.hand}${h.primary ? "·" : " "}`, 4, row);
        // Red "fast": the hand is moving too quickly for a pinch to start.
        const fast = handDebug.fast[h.hand];
        ctx.fillStyle = fast ? "rgba(248, 113, 113, 1)" : hot(pinch < params.pinchOn);
        ctx.fillText(fast ? "pin fast" : `pin ${pinch.toFixed(2)}`, 22, row);
        // Articulation: how fast this hand is changing shape. The candidate
        // signal for choosing a primary hand automatically. Watch whether the
        // two hands separate here during real use before trusting it.
        const art = handDebug.articulation[h.hand];
        const busier = art > handDebug.articulation[h.hand === "L" ? "R" : "L"];
        ctx.fillStyle = busier ? "rgba(210, 169, 63, 1)" : "rgba(139, 148, 158, 0.7)";
        ctx.fillText(`art ${art.toFixed(1)}`, 74, row);
        // Motion: how far this hand is from where it recently was, in palm
        // lengths. Decides which hand drives when both are in frame; gold
        // once it counts as moving.
        const mov = handDebug.motion[h.hand];
        ctx.fillStyle = !h.active
          ? "rgba(248, 113, 113, 1)"
          : mov > MOVE
            ? "rgba(210, 169, 63, 1)"
            : "rgba(139, 148, 158, 0.7)";
        ctx.fillText(h.active ? `mov ${mov.toFixed(2)}` : "ignored", 124, row);

        // Pose gate, on its own row: palm facing, fingers up, palm length (see
        // palm.ts). A value below its OFF threshold is what is keeping the
        // hand out, and shows red.
        const poseRow = H - 6 - readouts * 11;
        readouts++;
        const ok = "rgba(139, 148, 158, 0.9)";
        const bad = "rgba(248, 113, 113, 1)";
        ctx.fillStyle = h.pose.palm > PALM_OFF ? ok : bad;
        ctx.fillText(`palm ${h.pose.palm.toFixed(2)}`, 22, poseRow);
        ctx.fillStyle = h.pose.up > UP_OFF ? ok : bad;
        ctx.fillText(`up ${h.pose.up.toFixed(2)}`, 78, poseRow);
        ctx.fillStyle = h.pose.len > LEN_OFF ? ok : bad;
        ctx.fillText(`len ${h.pose.len.toFixed(2)}`, 124, poseRow);
      }

      // What the arbiter is doing about a handover, and while evidence for
      // one is building or draining, how far along it is.
      if (handDebug.arbiter) {
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillStyle =
          handDebug.arbiter === "switched" ? "rgba(45, 212, 191, 1)" : "rgba(210, 169, 63, 1)";
        const pct = Math.round(handDebug.evidence * 100);
        ctx.fillText(`swap: ${handDebug.arbiter}${pct > 0 ? ` ${pct}%` : ""}`, 4, 10);
      }

      if (handDebug.hands.length === 0) {
        ctx.fillStyle = "rgba(139, 148, 158, 0.8)";
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText("no hand", 8, H - 8);
      }
    });

    return () => {
      unsub();
      unsubParams();
    };
  }, [on, tracking]);

  if (!on || !tracking) return null;
  return <canvas className="hand-debug" ref={ref} style={{ width: W, height: H }} aria-hidden />;
}

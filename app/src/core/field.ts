// The field: the box around every node, plus a margin. It is "the entire
// space" as far as zoom is concerned: zooming out stops once all of it fits
// the screen, instead of carrying on until the graph is a speck.
//
// Panning is not bounded by it; only the zoom range is.

export interface Field {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Margin around the outermost nodes, in graph units, so the fitted view has
// some air around the graph.
export const FIELD_PAD = 120;

// The box around every positioned node, padded. With no nodes yet, a small
// box at the origin, where the layout will place them.
export function fieldOf(nodes: { x?: number; y?: number }[], pad = FIELD_PAD): Field {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (typeof n.x !== "number" || typeof n.y !== "number") continue;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  if (minX > maxX) return { minX: -pad, minY: -pad, maxX: pad, maxY: pad };
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

// How far out the zoom may go. At the limit the whole field fits the viewport
// with room to spare (it spans FIT of the tighter dimension), which is the
// widest view that is still useful: everything is visible at once.
//
// Clamped at both ends. A handful of nodes makes a small field, and fitting it
// would mean a limit above 1, forcing the view to zoom IN; MOST_IN stops that.
// A huge graph would fit only at a scale where nodes vanish; MOST_OUT stops
// that.
export const ZOOM_FIT = 0.7;
export const ZOOM_MOST_OUT = 0.3;
export const ZOOM_MOST_IN = 0.6;
export const ZOOM_MAX = 12;

export function minZoom(f: Field, viewW: number, viewH: number): number {
  const fw = f.maxX - f.minX;
  const fh = f.maxY - f.minY;
  if (!(fw > 0) || !(fh > 0) || !(viewW > 0) || !(viewH > 0)) return ZOOM_MOST_IN;
  const fit = Math.min(viewW / fw, viewH / fh) * ZOOM_FIT;
  return Math.min(ZOOM_MOST_IN, Math.max(ZOOM_MOST_OUT, fit));
}

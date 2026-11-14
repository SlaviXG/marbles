// One shared rAF ticker for all live motion (MOTION_PHILOSOPHY section 3/4:
// a single ticker, batched, and it stops when nothing is moving). Subscribers
// are called once per frame; the loop runs only while there is at least one.
type Frame = (nowMs: number) => void;

const subs = new Set<Frame>();
let raf = 0;

function loop(now: number) {
  for (const cb of [...subs]) cb(now);
  raf = subs.size ? requestAnimationFrame(loop) : 0;
}

export function subscribeFrame(cb: Frame): () => void {
  subs.add(cb);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    subs.delete(cb);
  };
}

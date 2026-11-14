// The page below uses plain pointer and click handlers only. Nothing in it
// knows about hands, which is the point: the library delivers ordinary events.
import { pointerStore, registerActionHandler, startHandPointer } from "../src";

const toggle = document.getElementById("toggle") as HTMLButtonElement;
const status = document.getElementById("status")!;
const box = document.getElementById("box")!;

let stop: (() => void) | null = null;
toggle.onclick = async () => {
  if (stop) {
    stop();
    stop = null;
  } else {
    stop = await startHandPointer();
  }
  toggle.textContent = stop ? "Stop hand pointer" : "Start hand pointer";
};
pointerStore.subscribe(() => {
  const s = pointerStore.getState();
  status.textContent = s.error ? `${s.status}: ${s.error}` : `${s.status} (${s.mode} has the cursor)`;
});

// Click targets: count clicks.
for (const b of document.querySelectorAll<HTMLButtonElement>(".targets button")) {
  let n = 0;
  b.onclick = () => (b.textContent = String(++n));
}

// Drag: standard pointer events.
let grab: { dx: number; dy: number } | null = null;
box.addEventListener("pointerdown", (e) => {
  const r = box.getBoundingClientRect();
  grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  box.classList.add("held");
});
window.addEventListener("pointermove", (e) => {
  if (!grab) return;
  box.style.left = `${e.clientX - grab.dx}px`;
  box.style.top = `${e.clientY - grab.dy}px`;
});
const drop = () => {
  grab = null;
  box.classList.remove("held");
};
window.addEventListener("pointerup", drop);
window.addEventListener("pointercancel", drop);

// Two-handed zoom arrives as a semantic action rather than a pointer event.
let scale = 1;
registerActionHandler((a) => {
  if (a.type !== "zoom") return false;
  scale = Math.min(4, Math.max(0.4, scale * Math.exp(-a.delta * 0.01)));
  box.style.transform = `scale(${scale})`;
  return true;
});

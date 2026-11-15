import { useEffect, type ReactNode } from 'react';

// One slide at a time. Pinch (or click) the slide to move on; the left edge
// goes back. Arrow keys and "next slide" / "previous slide" by voice do the
// same. The targets are the whole slide, so there is nothing small to aim at.
export const SLIDE_EVENT = 'marbles:slide';
export type SlideStep = { delta?: number; to?: 'first' | 'last' };

export default function SlidePager({ count, index, onChange, children }: { count: number; index: number; onChange: (index: number) => void; children: ReactNode }) {
  const go = (next: number) => { const clamped = Math.max(0, Math.min(count - 1, next)); if (clamped !== index) onChange(clamped); return clamped !== index; };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const delta = event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ' ? 1 : event.key === 'ArrowLeft' || event.key === 'PageUp' ? -1 : 0;
      // At either end the key falls through, so the arrows still move between files.
      if (delta && go(index + delta)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const spoken = (event: Event) => {
      const step = (event as CustomEvent<SlideStep>).detail;
      go(step.to === 'first' ? 0 : step.to === 'last' ? count - 1 : index + (step.delta ?? 1));
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener(SLIDE_EVENT, spoken);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener(SLIDE_EVENT, spoken); };
  });
  return <div className="slide-pager" role="group" aria-roledescription="slide deck" aria-label={`Slide ${index + 1} of ${count}`}>
    <div className="slide-stage">
      {children}
      <button className="slide-zone back" aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)} />
      <button className="slide-zone forward" aria-label="Next slide" disabled={index === count - 1} onClick={() => go(index + 1)} />
    </div>
    <div className="slide-bar">
      <button aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}>←</button>
      <div className="slide-progress" aria-hidden="true"><i style={{ transform: `scaleX(${(index + 1) / count})` }} /></div>
      <span role="status">{index + 1} / {count}</span>
      <button aria-label="Next slide" disabled={index === count - 1} onClick={() => go(index + 1)}>→</button>
    </div>
  </div>;
}

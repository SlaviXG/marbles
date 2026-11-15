import { useState } from 'react';
import type { PreviewSection } from './assetContent';
import SlidePager from './SlidePager';

// A presentation, shown one slide at a time. Each slide's first line is its
// title; the rest are its points.
export default function Deck({ slides }: { slides: PreviewSection[] }) {
  const [index, setIndex] = useState(0);
  const slide = slides[Math.min(index, slides.length - 1)];
  const [title, ...points] = slide.paragraphs ?? [];
  const cover = index === 0 && points.length <= 2;
  return <SlidePager count={slides.length} index={index} onChange={setIndex}>
    <div key={index} className={`deck-slide${cover ? ' cover' : ''}`}>
      <span className="deck-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
      <h3>{title ?? `Slide ${index + 1}`}</h3>
      {cover ? points.map((point, n) => <p key={n}>{point}</p>) : points.length > 0 && <ul>{points.map((point, n) => <li key={n}>{point}</li>)}</ul>}
    </div>
  </SlidePager>;
}

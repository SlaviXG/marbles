import type { PreviewSection } from './assetContent';

// A presentation, shown as slides rather than as extracted text. Each slide's
// first line is its title; the rest are its points.
export default function Deck({ slides }: { slides: PreviewSection[] }) {
  return <ol className="deck">
    {slides.map((slide, index) => {
      const [title, ...points] = slide.paragraphs ?? [];
      const cover = index === 0 && points.length <= 2;
      return <li key={index} className={`deck-slide${cover ? ' cover' : ''}`} style={{ animationDelay: `${Math.min(index, 8) * 90}ms` }}>
        <span className="deck-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
        <h3>{title ?? `Slide ${index + 1}`}</h3>
        {cover ? points.map((point, n) => <p key={n}>{point}</p>) : points.length > 0 && <ul>{points.map((point, n) => <li key={n}>{point}</li>)}</ul>}
      </li>;
    })}
  </ol>;
}

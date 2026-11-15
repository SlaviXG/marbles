import { useEffect, useRef, useState } from 'react';
import SlidePager from './SlidePager';

// An HTML file an agent produced. Scripts are never run (the file is untrusted
// output), which is exactly why an HTML slide deck used to be stuck on its
// first slide: its own "next" button is JavaScript.
//
// So the app pages it itself. Once the document has loaded it looks for the
// deck's slides, shows exactly one of them filling a 16:9 frame, and puts its
// own pinchable controls on top. A page that is not a deck is shown whole.
const FRAME = { width: 1280, height: 720 }; // the size slides are laid out at, then scaled to fit
const SLIDE_SELECTORS = ['.reveal .slides > section', '.slides > section', 'section.slide', '.slide', '[data-slide]', '.swiper-slide', 'body > section',
  'main > section', 'body > article', 'body > main > article', 'body > div > section', '.page'];

/** The deck's slides, in order: the first selector that finds at least two that are not nested in one another. */
export function findSlides(doc: Document): HTMLElement[] {
  for (const selector of SLIDE_SELECTORS) {
    const found = Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter(element => !element.parentElement?.closest(selector));
    if (found.length >= 2) return found;
  }
  return [];
}

function showOnly(slides: HTMLElement[], index: number) {
  // Decks hide inactive slides in CSS and reveal them from script. Decide each
  // slide's own layout mode from one that is visible, then force the choice.
  const view = slides[0].ownerDocument.defaultView;
  const natural = slides.map(slide => view?.getComputedStyle(slide).display).find(display => display && display !== 'none') ?? 'block';
  slides.forEach((slide, n) => {
    if (n !== index) { slide.style.setProperty('display', 'none', 'important'); return; }
    for (const [name, value] of [['display', natural], ['position', 'fixed'], ['inset', '0'], ['width', '100vw'], ['height', '100vh'], ['opacity', '1'], ['visibility', 'visible'],
      ['transform', 'none'], ['overflow', 'auto'], ['box-sizing', 'border-box'], ['margin', '0'], ['z-index', '2147483000']]) slide.style.setProperty(name, value, 'important');
  });
}

export default function HtmlDeck({ name, src }: { name: string; src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const slides = useRef<HTMLElement[]>([]);
  const [count, setCount] = useState<number | null>(null); // null: not loaded yet; 0: an ordinary page
  const [index, setIndex] = useState(0);
  const [scale, setScale] = useState(.5);

  const loaded = () => {
    const element = frame.current;
    if (!element) return;
    try {
      const doc = element.contentDocument;
      if (!doc) throw new Error('unreadable');
      slides.current = findSlides(doc);
      if (slides.current.length) {
        const style = doc.createElement('style');
        style.textContent = 'html,body{margin:0!important;width:100vw!important;height:100vh!important;overflow:hidden!important}';
        doc.head.appendChild(style);
        showOnly(slides.current, 0);
        setIndex(0); setCount(slides.current.length);
      } else {
        // Not a deck: give the page its full height and let the reader scroll it.
        element.style.height = `${Math.min(12000, Math.max(480, doc.documentElement.scrollHeight))}px`;
        setCount(0);
      }
    } catch { setCount(0); /* a redirected or unreadable page keeps a readable viewport */ }
  };
  useEffect(() => { if (count) showOnly(slides.current, index); }, [index, count]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => setScale(element.clientWidth / FRAME.width);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);

  const page = <iframe ref={frame} title={name} sandbox="allow-same-origin" src={src} onLoad={loaded}
    style={count ? { width: FRAME.width, height: FRAME.height, transform: `scale(${scale})`, transformOrigin: '0 0' } : undefined} />;
  if (!count) return page;
  return <SlidePager count={count} index={index} onChange={setIndex}>
    <div className="html-slide" ref={box}>{page}</div>
  </SlidePager>;
}

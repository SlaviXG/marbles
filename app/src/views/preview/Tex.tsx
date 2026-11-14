import { useEffect, useState } from 'react';

// LaTeX, typeset with KaTeX. The library and its fonts load on first use, so
// documents without maths never pay for them. KaTeX output is safe markup
// (trust is off), which is the only HTML string the reader ever injects.
let loading: Promise<typeof import('katex')['default']> | undefined;
const load = () => loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([module]) => module.default);

export default function Tex({ tex, display = false }: { tex: string; display?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(katex => { if (live) setHtml(katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' })); })
      .catch(() => { if (live) setHtml(null); });
    return () => { live = false; };
  }, [tex, display]);
  return html === null ? <span className={`tex pending${display ? ' block' : ''}`}><code>{tex}</code></span>
    : <span className={`tex${display ? ' block' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

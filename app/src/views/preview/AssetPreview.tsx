import { useEffect, useRef, useState } from 'react';
import type { ArtifactInfo } from '../../core/agentTypes';
import { parseDelimited, readOffice, type PreviewSection } from './assetContent';
import Markdown from './Markdown';
import Deck from './Deck';
import { texToMarkdown } from './latexSource';

const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
export default function AssetPreview({ artifact }: { artifact: ArtifactInfo }) {
  const ext = extension(artifact.name);
  const url = `/api/artifacts/file?path=${encodeURIComponent(artifact.path)}`;
  const [sections, setSections] = useState<PreviewSection[] | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState('');
  const image = /^(png|jpe?g|webp|gif|svg|bmp|avif|ico)$/.test(ext);
  const media = /^(mp3|wav|ogg|m4a|mp4|webm|mov)$/.test(ext);
  const html = /^(html|htm)$/.test(ext);
  useEffect(() => {
    setSections(null); setMarkdown(null); setError('');
    if (image || media || html || ext === 'pdf') return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('The asset is not ready yet.');
        const size = Number(response.headers.get('Content-Length'));
        if (size > 24_000_000) throw new Error('This asset exceeds the inline reader’s size limit.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 24_000_000) throw new Error('This asset exceeds the inline reader’s size limit.');
        let next: PreviewSection[];
        if (/^(docx|xlsx|pptx|odt|ods|odp)$/.test(ext)) next = readOffice(bytes);
        else {
          const text = new TextDecoder().decode(bytes);
          if (ext === 'tex') { if (!controller.signal.aborted) setMarkdown(texToMarkdown(text)); return; }
          if (/^(md|markdown|mdx)$/.test(ext)) { if (!controller.signal.aborted) setMarkdown(text); return; }
          if (/^(csv|tsv)$/.test(ext)) next = [{ title: 'Table', rows: parseDelimited(text, ext === 'tsv' ? '\t' : ',').slice(0, 2000) }];
          else if (bytes.slice(0, 4000).includes(0)) next = [{ title: 'Binary file preview', paragraphs: [Array.from(bytes.slice(0, 2048), value => value.toString(16).padStart(2, '0')).join(' ')] }];
          else next = [{ title: 'Content', paragraphs: [text] }];
        }
        if (!controller.signal.aborted) setSections(next);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Preview could not load.'); }
    })();
    return () => controller.abort();
  }, [url, ext, image, media, html]);

  return <div className="asset-preview" aria-label={`${artifact.name} inline preview`}>
    {image ? <img src={url} alt={artifact.name} onError={() => setError('This image is not ready yet.')} />
      : ext === 'pdf' ? <PdfPreview url={url} />
      : /^(mp3|wav|ogg|m4a)$/.test(ext) ? <audio controls src={url} />
      : media ? <video controls src={url} />
      : html ? <iframe title={artifact.name} sandbox="allow-same-origin" src={`/api/artifacts/view/${artifact.path.split('/').map(encodeURIComponent).join('/')}`} onLoad={event => {
        const frame = event.currentTarget;
        try { frame.style.height = `${Math.min(12000, Math.max(480, frame.contentDocument?.documentElement.scrollHeight ?? 480))}px`; } catch { /* Keep a readable viewport for redirected pages. */ }
      }} />
      : error ? <p role="alert">{error}</p>
      : markdown !== null ? <Markdown text={markdown} path={artifact.path} />
      : !sections ? <div className="preview-loading" role="status"><span className="voice-sr-only">Preparing preview…</span><i /><i /><i /><i /></div>
      : /^(pptx|ppt|odp)$/.test(ext) && sections.every(section => section.paragraphs) ? <Deck slides={sections} />
      : sections.map((section, index) => <section className="asset-section" key={index}>
        {sections.length > 1 && <h3>{section.title}</h3>}
        {section.rows ? <div className="asset-table-wrap"><table><tbody>{section.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => r === 0 ? <th key={c} scope="col">{cell}</th> : <td key={c}>{cell}</td>)}</tr>)}</tbody></table>{section.rows.length >= 2000 && <p>Showing the first 2,000 rows.</p>}</div>
          : section.paragraphs?.map((text, p) => <p className="asset-paragraph" key={p}>{text}</p>)}
      </section>)}
    {error && (image || media || html) && <p role="alert">{error}</p>}
  </div>;
}

function PdfPreview({ url }: { url: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState('Preparing PDF…');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let destroy: (() => void) | undefined;
    container.current?.replaceChildren(); setProgress('Preparing PDF…'); setError('');
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        if (!live) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ url });
        destroy = () => { void task.destroy(); };
        const pdf = await task.promise;
        const host = container.current;
        if (!host || !live) return;
        setProgress(`${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'} · scroll to explore`);
        const first = await pdf.getPage(1);
        const firstView = first.getViewport({ scale: 1 });
        const observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            const holder = entry.target as HTMLDivElement;
            if (!entry.isIntersecting || holder.dataset.rendered) continue;
            holder.dataset.rendered = 'true';
            void (async () => {
              try {
                const number = Number(holder.dataset.page);
                const page = await pdf.getPage(number);
                const original = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: Math.min(1.7, 1200 / original.width) });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width; canvas.height = viewport.height;
                canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF page ${number}`);
                const context = canvas.getContext('2d');
                if (!context || !live) return;
                await page.render({ canvas, canvasContext: context, viewport }).promise;
                if (live) { holder.replaceChildren(canvas); holder.style.aspectRatio = `${viewport.width} / ${viewport.height}`; }
              } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : 'A PDF page could not load.'); }
            })();
          }
        }, { rootMargin: '700px' });
        for (let number = 1; number <= pdf.numPages; number++) {
          const holder = document.createElement('div');
          holder.className = 'pdf-page'; holder.dataset.page = String(number);
          holder.style.aspectRatio = `${firstView.width} / ${firstView.height}`;
          host.append(holder); observer.observe(holder);
        }
        const cancel = destroy;
        destroy = () => { observer.disconnect(); cancel?.(); };

      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : 'PDF preview could not load.'); }
    })();
    return () => { live = false; destroy?.(); };
  }, [url]);
  return <><p className="preview-status" role={error ? 'alert' : 'status'}>{error || progress}</p><div className="pdf-pages" ref={container} /></>;
}

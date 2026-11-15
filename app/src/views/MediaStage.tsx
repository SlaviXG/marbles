import { useEffect, useRef } from 'react';
import { useDisplay, type Display, type Video } from '../state/display';

type Stage = Exclude<Display, Video>;
import { useVault } from '../state/store';
import { steady, registerActionHandler, PRIORITY } from '../input';
import { useDragScroll } from '../hooks/useDragScroll';
import { useDragMove } from '../hooks/useDragMove';

// Anything Marbles shows you that is not a teammate's file lands here: pictures
// from the web, a video, or an email / call waiting for a yes. It opens out of
// the voice core the same way a result opens out of its agent.
const heading = (display: Stage) => display.kind === 'images' ? display.query
  : display.kind === 'email' ? display.subject : display.name || display.number;
const label = (display: Stage) => display.kind === 'images' ? `Web / ${display.images.length} pictures`
  : display.kind === 'email' ? 'Email / draft' : 'Call';

function Glyph({ kind }: { kind: Stage['kind'] }) {
  return <svg className="media-glyph" viewBox="0 0 40 40" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'images' ? <><rect x="5" y="8" width="30" height="24" rx="2" /><circle cx="14" cy="16" r="2.6" /><path d="m7 30 9-10 6 6 4-4 8 8" /></>
      : kind === 'email' ? <><rect x="5" y="9" width="30" height="22" rx="2" /><path d="m6 11 14 11 14-11" /></>
      : <path d="M13 6h-4a2 2 0 0 0-2 2c0 14 11 25 25 25a2 2 0 0 0 2-2v-4l-7-3-3 3c-4-2-7-5-9-9l3-3Z" />}
  </svg>;
}

export default function MediaStage() {
  const display = useDisplay(s => s.display);
  const index = useDisplay(s => s.index);
  const status = useDisplay(s => s.status);
  const note = useDisplay(s => s.note);
  const mailFallback = useDisplay(s => s.mailFallback);
  const selectedId = useVault(s => s.selectedId);
  const body = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useDragScroll(body);
  const screen = useRef<HTMLElement>(null);
  const bar = useRef<HTMLElement>(null);
  useDragMove(screen, bar, display);

  // Opening a teammate or a file takes the stage back.
  useEffect(() => { if (selectedId) useDisplay.getState().close(); }, [selectedId]);
  useEffect(() => {
    if (!display) return;
    const release = steady.hold();
    title.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      const view = useDisplay.getState();
      if (event.key === 'Escape') { event.preventDefault(); if (view.index != null) view.focus(null); else view.close(); }
      else if (display.kind === 'images' && event.key === 'ArrowRight') view.step(1);
      else if (display.kind === 'images' && event.key === 'ArrowLeft') view.step(-1);
    };
    window.addEventListener('keydown', key);
    // A hand pan scrolls whatever is on the stage.
    const unregister = registerActionHandler(action => {
      if (action.type !== 'pan' || !body.current) return action.type === 'zoom';
      body.current.scrollTop -= action.dy;
      return true;
    }, PRIORITY.overlay);
    return () => { release(); window.removeEventListener('keydown', key); unregister(); };
  }, [display]);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [display, index]);

  if (!display) return null;
  const { close, focus, step, confirm } = useDisplay.getState();
  const shown = display.kind === 'images' && index != null ? display.images[index] : null;
  const settled = status === 'done';
  return <div className={`media-stage ${display.kind}${shown ? ' focused' : ''}`}>
    <section className="presentation-screen media-screen" ref={screen} data-closable="media" role="dialog" aria-label={`${label(display)}: ${heading(display)}`}>
      <header className="presentation-header window-grip" ref={bar}>
        <Glyph kind={display.kind} />
        <div className="presentation-title">
          <p className="presentation-sender">{label(display)}</p>
          <h2 ref={title} tabIndex={-1}>{heading(display)}</h2>
        </div>
        <button className="presentation-close" aria-label="Close" onClick={close}><span aria-hidden="true">×</span></button>
      </header>
      <div className="presentation-reader media-body" ref={body}>
        {display.kind === 'images' && !shown && <div className="media-grid">
          {display.images.map((image, n) => <button key={image.full} className="media-tile" style={{ animationDelay: `${520 + Math.min(n, 14) * 55}ms` }}
            aria-label={image.title || `Picture ${n + 1}`} onClick={() => focus(n)}>
            <img src={image.url} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={event => { event.currentTarget.parentElement!.hidden = true; }} />
          </button>)}
        </div>}
        {shown && <figure className="media-focus" key={shown.full}>
          <img src={shown.url} alt={shown.title} referrerPolicy="no-referrer" draggable={false} />
          <figcaption>{shown.title}{shown.credit && <span>{shown.credit}</span>}</figcaption>
        </figure>}
        {display.kind === 'email' && <div className="media-letter">
          <dl><dt>To</dt><dd>{display.name && <strong>{display.name}</strong>}{display.to}</dd></dl>
          <p>{display.body}</p>
          {!!display.attachments?.length && <dl><dt>Attachments</dt><dd>{display.attachments.map(file => <div key={file.path}>{file.name} <small>({file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`})</small></div>)}</dd></dl>}
        </div>}
        {display.kind === 'call' && <div className="media-call">
          <div className={`media-call-ring${status === 'working' || settled ? ' live' : ''}`} aria-hidden="true"><i /><i /><i /><Glyph kind="call" /></div>
          {display.name && <p className="media-call-number">{display.number}</p>}
        </div>}
      </div>
      {(shown || display.kind === 'email' || display.kind === 'call') && <footer className="presentation-footer media-actions">
        {shown && <>
          <button className="holo-chip" onClick={() => step(-1)} aria-label="Previous picture">←</button>
          <button className="holo-chip" onClick={() => focus(null)}>All pictures</button>
          <button className="holo-chip" onClick={() => step(1)} aria-label="Next picture">→</button>
        </>}
        {!shown && <>
          <p className={`media-status ${status}`} role="status">{note || (display.kind === 'email' ? 'Say “send it”, or pinch Send' : 'Say “call”, or pinch Call')}</p>
          {!settled && <button className="holo-chip" onClick={close}>{display.kind === 'email' ? 'Discard' : 'Cancel'}</button>}
          {mailFallback && <button className="holo-chip" onClick={() => void confirm('mail')}>Send with Mail</button>}
          {!settled && <button className="holo-chip on" disabled={status === 'working'} onClick={() => void confirm()}>{display.kind === 'email' ? (status === 'failed' ? 'Try again' : 'Send') : 'Call'}</button>}
          {settled && <button className="holo-chip on" onClick={close}>Done</button>}
        </>}
      </footer>}
      <div className="presentation-scan" aria-hidden="true" />
      <div className="presentation-flash" aria-hidden="true" />
      <i className="holo-corner tl" aria-hidden="true" /><i className="holo-corner tr" aria-hidden="true" /><i className="holo-corner bl" aria-hidden="true" /><i className="holo-corner br" aria-hidden="true" />
    </section>
  </div>;
}

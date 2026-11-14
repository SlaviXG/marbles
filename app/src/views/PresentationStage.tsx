import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { artifactSelection, presentationLayout, PRESENTATION_ENTER_MS, PRESENTATION_FOLD_MS } from '../core/presentation';
import { usePresentation, presentationAnchor, agentScreenPoint } from '../state/presentation';
import { useAgents } from '../state/agents';
import { useVault } from '../state/store';
import { cameraPointer, registerActionHandler, PRIORITY } from '../input';
import { useDragScroll } from '../hooks/useDragScroll';
import { useDragMove } from '../hooks/useDragMove';
import { SpringValue } from '../motion/SpringValue';
import { subscribeFrame } from '../motion/ticker';
import AssetPreview from './preview/AssetPreview';
import FileGlyph, { fileExtension, fileTitle } from './FileGlyph';

// A result is projected, not opened: the agent throws a line of light across
// the room, the line opens into a screen, and the document prints onto it.
// Closing runs the film backwards. The screen stays lit by a beam from its
// agent the whole time, so it is always clear whose work is on show.
const REST = 'perspective(1600px) rotateY(-1.5deg)';

export default function PresentationStage() {
  const active = usePresentation(s => s.active);
  const phase = usePresentation(s => s.phase);
  const index = usePresentation(s => s.index);
  const queueCount = usePresentation(s => s.queue.length);
  const upNext = usePresentation(s => s.queue[0]);
  const agents = useAgents(s => s.agents);
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  const frame = useRef<HTMLElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tether = useRef<SVGPathElement>(null);
  const cone = useRef<SVGPolygonElement>(null);
  const emitter = useRef<SVGCircleElement>(null);
  const beamFill = useRef<SVGLinearGradientElement>(null);
  const animation = useRef<Animation>();
  const scroll = useRef(new SpringValue('calm', 0));
  const zoom = useRef(new SpringValue('calm', 1));
  const tiltX = useRef(new SpringValue('calm', 0));
  const tiltY = useRef(new SpringValue('calm', 0));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const smoothing = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const layout = presentationLayout(size.width, size.height);
  useDragScroll(reader);
  const bar = useRef<HTMLElement>(null);
  const moved = useDragMove(frame, bar, active?.key ?? null);
  useEffect(() => {
    const resize = () => setSize({ width: innerWidth, height: innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useLayoutEffect(() => {
    if (!active || !frame.current) return;
    const element = frame.current;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.inert = phase === 'returning';
    const origin = agentScreenPoint(active.leadAgentId);
    const dx = origin.x - (layout.panel.left + layout.panel.width / 2);
    const dy = origin.y - (layout.panel.top + layout.panel.height / 2);
    // Three beats: a spark at the agent, a line of light across the room, a screen.
    const spark = `perspective(1600px) translate3d(${dx}px,${dy}px,0) rotateY(0deg) scale(.015,.004)`;
    const line = 'perspective(1600px) translate3d(0,0,0) rotateY(0deg) scale(1,.004)';
    const open = 'perspective(1600px) translate3d(0,0,0) rotateY(-1.5deg) scale(1,1)';
    const current = getComputedStyle(element);
    const from = { transform: current.transform, opacity: current.opacity };
    animation.current?.cancel();
    if (reduced) { element.style.transform = 'none'; element.style.opacity = phase === 'returning' ? '0' : '1'; return; }
    if (phase === 'approaching') {
      animation.current = element.animate([
        { transform: spark, opacity: 0, easing: 'cubic-bezier(.5,0,.1,1)' },
        { transform: line, opacity: 1, offset: .44, easing: 'cubic-bezier(.16,1,.3,1)' },
        { transform: open, opacity: 1 },
      ], { duration: PRESENTATION_ENTER_MS, fill: 'forwards' });
    } else if (phase === 'returning') {
      animation.current = element.animate([
        { ...from, easing: 'cubic-bezier(.6,0,.8,.2)' },
        { transform: line, opacity: 1, offset: .5, easing: 'cubic-bezier(.6,0,.9,.4)' },
        { transform: spark, opacity: 0 },
      ], { duration: PRESENTATION_FOLD_MS, fill: 'forwards' });
    } else { element.style.transform = REST; element.style.opacity = '1'; }
    return () => { animation.current?.cancel(); };
  }, [active?.key, phase, layout.panel.left, layout.panel.top, layout.panel.width, layout.panel.height]);
  useEffect(() => {
    if (!active) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus({ preventScroll: true });
    return () => { restoreFocus.current?.isConnected && restoreFocus.current.focus({ preventScroll: true }); };
  }, [active?.key]);
  useEffect(() => {
    if (reader.current) reader.current.scrollTop = 0;
    scroll.current.jump(0); zoom.current.jump(1); smoothing.current = false;
    reader.current?.style.setProperty('--reader-zoom', '1');
  }, [active?.key, index]);
  useEffect(() => {
    if (!active) return;
    cameraPointer.setStabilize(true);
    return () => cameraPointer.setStabilize(false);
  }, [!!active]);
  useEffect(() => {
    if (!active || phase === 'returning') return;
    return registerActionHandler(action => {
      const element = reader.current;
      if (!element) return false;
      if (action.type === 'pan') {
        if (!smoothing.current) scroll.current.jump(element.scrollTop);
        scroll.current.setTarget(Math.max(0, Math.min(element.scrollHeight - element.clientHeight, scroll.current.goal - action.dy)));
      } else if (action.type === 'zoom') {
        zoom.current.setTarget(Math.min(1.8, Math.max(.7, zoom.current.goal - action.delta * (action.pinch ? .0025 : .0004))));
      } else return false;
      smoothing.current = true;
      return true;
    }, PRIORITY.overlay);
  }, [!!active, phase]);
  useEffect(() => {
    if (!active) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The screen leans a degree or two toward the hand, like a held object.
    const lean = (event: PointerEvent) => {
      tiltX.current.setTarget((event.clientX / innerWidth - .5) * 2);
      tiltY.current.setTarget((event.clientY / innerHeight - .5) * 2);
    };
    if (!reduced) window.addEventListener('pointermove', lean, { passive: true });
    let lastTilt = '';
    const stop = subscribeFrame(now => {
      const element = reader.current;
      if (element && smoothing.current) {
        const scrollDone = scroll.current.update(now / 1000);
        const zoomDone = zoom.current.update(now / 1000);
        element.scrollTop = scroll.current.value;
        element.style.setProperty('--reader-zoom', String(zoom.current.value));
        smoothing.current = !scrollDone || !zoomDone;
      }
      if (!reduced && phaseRef.current === 'presenting' && frame.current) {
        tiltX.current.update(now / 1000); tiltY.current.update(now / 1000);
        const next = `perspective(1600px) rotateY(${(-1.5 + tiltX.current.value * 1.3).toFixed(3)}deg) rotateX(${(tiltY.current.value * -.9).toFixed(3)}deg)`;
        if (next !== lastTilt) { frame.current.style.transform = next; lastTilt = next; }
      }
      // The beam: a hairline core plus a cone of light fanning onto the screen edge.
      const anchor = presentationAnchor;
      // The beam follows the screen wherever it has been dragged.
      const left = layout.panel.left + moved.current.x, top = layout.panel.top + moved.current.y, height = layout.panel.height;
      const end = { x: left + 2, y: top + 84 };
      tether.current?.setAttribute('d', `M${anchor.x},${anchor.y} C${anchor.x + 50},${anchor.y} ${end.x - 60},${end.y} ${end.x},${end.y}`);
      cone.current?.setAttribute('points', `${anchor.x},${anchor.y} ${left},${top + 6} ${left},${top + height - 6}`);
      emitter.current?.setAttribute('cx', String(anchor.x)); emitter.current?.setAttribute('cy', String(anchor.y));
      beamFill.current?.setAttribute('x1', String(anchor.x)); beamFill.current?.setAttribute('x2', String(left));
    });
    return () => { stop(); window.removeEventListener('pointermove', lean); };
  }, [active?.key, layout.panel.left, layout.panel.top, layout.panel.height]);
  useEffect(() => {
    if (!active || phase === 'returning') return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); useVault.getState().clear(); }
      if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !(event.target instanceof HTMLInputElement)) {
        const next = index + (event.key === 'ArrowRight' ? 1 : -1);
        if (next >= 0 && next < active.artifacts.length) { event.preventDefault(); useVault.getState().select(artifactSelection(active, next)); }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, index, phase]);

  if (!active) return null;
  const artifact = active.artifacts[index];
  const sender = agents.find(agent => agent.id === active.leadAgentId)?.name ?? active.leadAgentId;
  const returning = phase === 'returning';
  const many = active.artifacts.length > 1;
  return <div className={`presentation-stage ${phase}`} data-presentation-phase={phase}>
    <svg className="presentation-beam" aria-hidden="true">
      <defs>
        <linearGradient id="presentation-beam-fill" ref={beamFill} gradientUnits="userSpaceOnUse" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(88% .11 205)" stopOpacity=".42" />
          <stop offset=".5" stopColor="oklch(80% .12 210)" stopOpacity=".1" />
          <stop offset="1" stopColor="oklch(80% .12 210)" stopOpacity=".03" />
        </linearGradient>
      </defs>
      <polygon ref={cone} fill="url(#presentation-beam-fill)" />
      <path ref={tether} />
      <circle ref={emitter} r="4" />
    </svg>
    <section className="presentation-screen" ref={frame} role="region" aria-label={`${sender} presenting ${artifact.name}`} aria-hidden={returning}
      style={{ left: layout.panel.left, top: layout.panel.top, width: layout.panel.width, height: layout.panel.height }}>
      <header className="presentation-header window-grip" ref={bar}>
        <FileGlyph name={artifact.name} size={38} />
        <div className="presentation-title">
          <p className="presentation-sender">{sender}<span aria-hidden="true">/</span>{fileExtension(artifact.name)}</p>
          <h2 ref={heading} tabIndex={-1} key={artifact.path} title={artifact.name}>{fileTitle(artifact.name)}</h2>
        </div>
        {upNext && <button className="presentation-next" disabled={returning} title={upNext.title}
          aria-label={`Show the next result: ${upNext.title}. ${queueCount} waiting.`} onClick={() => useVault.getState().select(artifactSelection(upNext))}>Next<span aria-hidden="true">{queueCount}</span></button>}
        <button className="presentation-close" aria-label="Close preview and return agent" disabled={returning} onClick={() => useVault.getState().clear()}><span aria-hidden="true">×</span></button>
      </header>
      <div className="presentation-reader" ref={reader}><div className="presentation-content" key={artifact.path}><AssetPreview artifact={artifact} /></div></div>
      {many && <footer className="presentation-footer">
        <div className="holo-strip" role="tablist" aria-label="Files in this result">
          {active.artifacts.map((file, n) => <button key={file.path} role="tab" aria-selected={n === index} aria-label={file.name}
            className={`holo-chip${n === index ? ' on' : ''}`} style={{ animationDelay: `${520 + Math.min(n, 10) * 60}ms` }} disabled={returning}
            onClick={() => useVault.getState().select(artifactSelection(active, n))}>
            <FileGlyph name={file.name} size={20} /><span>{fileTitle(file.name)}</span>
          </button>)}
        </div>
      </footer>}
      {/* Light that the screen is made of: a flash while it opens, a scan as each file prints. */}
      <div className="presentation-scan" key={`scan:${artifact.path}`} aria-hidden="true" />
      <div className="presentation-flash" aria-hidden="true" />
      <i className="holo-corner tl" aria-hidden="true" /><i className="holo-corner tr" aria-hidden="true" /><i className="holo-corner bl" aria-hidden="true" /><i className="holo-corner br" aria-hidden="true" />
    </section>
    <p className="presentation-announcement voice-sr-only" role="status">{returning ? `${sender} is returning to the team.` : `${sender} is presenting ${artifact.name}.`}</p>
  </div>;
}

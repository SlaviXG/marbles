import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { artifactSelection, presentationLayout, PRESENTATION_ENTER_MS, PRESENTATION_FOLD_MS } from '../core/presentation';
import { usePresentation, presentationAnchor, agentScreenPoint } from '../state/presentation';
import { useAgents } from '../state/agents';
import { useVault } from '../state/store';
import { cameraPointer, registerActionHandler, PRIORITY } from '../input';
import { useDragScroll } from '../hooks/useDragScroll';
import { SpringValue } from '../motion/SpringValue';
import { subscribeFrame } from '../motion/ticker';
import AssetPreview from './preview/AssetPreview';

export default function PresentationStage() {
  const active = usePresentation(s => s.active);
  const phase = usePresentation(s => s.phase);
  const index = usePresentation(s => s.index);
  const queueCount = usePresentation(s => s.queue.length);
  const agents = useAgents(s => s.agents);
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  const frame = useRef<HTMLElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tether = useRef<SVGPathElement>(null);
  const animation = useRef<Animation>();
  const scroll = useRef(new SpringValue('calm', 0));
  const zoom = useRef(new SpringValue('calm', 1));
  const smoothing = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const layout = presentationLayout(size.width, size.height);
  useDragScroll(reader);
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
    const folded = `perspective(1400px) translate3d(${dx}px,${dy}px,0) scale(.035) rotateY(-22deg)`;
    const unfolded = 'perspective(1400px) translate3d(0,0,0) scale(1) rotateY(-1.5deg)';
    const current = getComputedStyle(element);
    const from = { transform: current.transform, opacity: current.opacity };
    animation.current?.cancel();
    if (reduced) { element.style.transform = 'none'; element.style.opacity = phase === 'returning' ? '0' : '1'; return; }
    if (phase === 'approaching') {
      animation.current = element.animate([{ transform: folded, opacity: 0 }, { transform: unfolded, opacity: 1 }],
        { duration: PRESENTATION_ENTER_MS, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
    } else if (phase === 'returning') {
      animation.current = element.animate([from, { transform: folded, opacity: 0 }],
        { duration: PRESENTATION_FOLD_MS, easing: 'cubic-bezier(.7,0,.84,0)', fill: 'forwards' });
    } else { element.style.transform = unfolded; element.style.opacity = '1'; }
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
    return subscribeFrame(now => {
      const element = reader.current;
      if (element && smoothing.current) {
        const scrollDone = scroll.current.update(now / 1000);
        const zoomDone = zoom.current.update(now / 1000);
        element.scrollTop = scroll.current.value;
        element.style.setProperty('--reader-zoom', String(zoom.current.value));
        smoothing.current = !scrollDone || !zoomDone;
      }
      const anchor = presentationAnchor;
      const end = { x: layout.panel.left + 2, y: layout.panel.top + 84 };
      tether.current?.setAttribute('d', `M${anchor.x},${anchor.y} C${anchor.x + 50},${anchor.y} ${end.x - 60},${end.y} ${end.x},${end.y}`);
    });
  }, [active?.key, layout.panel.left, layout.panel.top]);
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
  return <div className={`presentation-stage ${phase}`} data-presentation-phase={phase}>
    <svg className="presentation-tether" aria-hidden="true"><path ref={tether} /></svg>
    <section className="presentation-screen" ref={frame} role="region" aria-label={`${sender} presenting ${artifact.name}`} aria-hidden={returning}
      style={{ left: layout.panel.left, top: layout.panel.top, width: layout.panel.width, height: layout.panel.height }}>
      <header className="presentation-header">
        <div><p className="presentation-sender"><span />{sender}<span className="presentation-complete">Task complete</span></p><h2 ref={heading} tabIndex={-1}>{artifact.name}</h2></div>
        <button className="presentation-close" aria-label="Close preview and return agent" disabled={returning} onClick={() => useVault.getState().clear()}><span aria-hidden="true">×</span></button>
      </header>
      <div className="presentation-reader" ref={reader}><div className="presentation-content"><AssetPreview key={artifact.path} artifact={artifact} /></div></div>
      <footer className="presentation-footer">
        <span>{active.artifacts.length > 1 ? `${index + 1} of ${active.artifacts.length} files` : 'Point and pinch to explore'}</span>
        {active.artifacts.length > 1 && <div className="presentation-file-controls">
          <button aria-label="Previous asset" disabled={index === 0 || returning} onClick={() => useVault.getState().select(artifactSelection(active, index - 1))}>←</button>
          <button aria-label="Next asset" disabled={index === active.artifacts.length - 1 || returning} onClick={() => useVault.getState().select(artifactSelection(active, index + 1))}>→</button>
        </div>}
        <span className="presentation-queue" role="status">{queueCount ? `${queueCount} more ${queueCount === 1 ? 'result' : 'results'} waiting` : 'Close to return your agent home'}</span>
      </footer>
    </section>
    <p className="presentation-announcement voice-sr-only" role="status">{returning ? `${sender} is returning to the team.` : `${sender} is presenting ${artifact.name}.`}</p>
  </div>;
}

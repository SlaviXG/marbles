import { useCallback, useEffect, useLayoutEffect, useRef, useState, type AnimationEvent } from "react";
import { useVault } from "../state/store";
import { useAgents, refreshTasks } from "../state/agents";
import type { AgentInfo, AgentLog, AgentTask, ArtifactInfo } from "../core/agentTypes";
import { getDetail, hostname, type Detail } from "../core/detail";
import { sampleSpring, springDurationMs } from "../motion/springs";
import { SpringValue } from "../motion/SpringValue";
import { subscribeFrame } from "../motion/ticker";
import { pickPreview } from "./preview";
import PreviewFrame from "./preview/PreviewFrame";
import { cameraPointer, registerActionHandler, PRIORITY } from "../input";
import { useDragScroll } from "../hooks/useDragScroll";

const REDUCED_MOTION =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Track A (MOTION_PHILOSOPHY section 3): pre-resolve the spring to keyframes and
// hand it to the compositor via WAAPI, so the slide stays smooth even if the
// main thread is busy. Only transform/opacity animate.
const SLIDE = sampleSpring("calm");
const SLIDE_MS = springDurationMs("calm");

export default function DetailPanel() {
  const notes = useVault((s) => s.notes);
  const agents = useAgents((s) => s.agents);
  const tasks = useAgents((s) => s.tasks);
  const selectedId = useVault((s) => s.selectedId);
  const select = useVault((s) => s.select);
  const clear = useVault((s) => s.clear);

  const open = selectedId ? selectedId.startsWith('agent:') ? agents.some(a => `agent:${a.instanceName}` === selectedId) : selectedId.startsWith('task:') ? tasks.some(t => `task:${t.id}` === selectedId) : selectedId.startsWith('artifact:') ? true : !!getDetail(notes, selectedId) : false;

  const scrimRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // Node-to-node navigation plays a quick dip: fade the current content out, swap
  // at the trough, fade the new content in. Sequenced (not a crossfade) so the
  // two texts never overlap, but fast enough to read as one motion. A fresh open
  // shows immediately (the window's own fade covers it); on close the content is
  // kept for the window fade-out.
  const [displayedId, setDisplayedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");
  const wasOpen = useRef(false);
  const pendingId = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Reader zoom and gesture scroll, both spring-smoothed. Gesture actions arrive
  // at the ~15fps inference rate; writing them straight to the DOM shows that
  // rate as stepping, so the springs carry them to display rate. Refs, not
  // state: they change per frame and must not re-render the note being read.
  const scaleSpring = useRef(new SpringValue("responsive", 1));
  const scrollSpring = useRef(new SpringValue("responsive", 0));
  const smoothing = useRef<(() => void) | null>(null);

  // One ticker subscription for both, started on demand and stopped on settle,
  // so a note that is merely open costs nothing on the CV-shared thread.
  const startSmoothing = useCallback(() => {
    if (smoothing.current) return;
    const stop = subscribeFrame((now) => {
      const t = now / 1000;
      const scaleDone = scaleSpring.current.update(t);
      const scrollDone = scrollSpring.current.update(t);
      const el = scrollerRef.current;
      if (el) {
        el.style.setProperty("--text-scale", String(scaleSpring.current.value));
        el.scrollTop = scrollSpring.current.value;
      }
      if (scaleDone && scrollDone) {
        stop();
        smoothing.current = null;
      }
    });
    smoothing.current = stop;
  }, []);

  useEffect(() => () => smoothing.current?.(), []);
  // Drag-to-scroll: press and drag the content (real mouse or camera-cursor
  // pinch) moves it vertically, like a touch surface. The returned state lets the
  // hover-out logic below ignore the tail of a drag that ends in the exit area.
  const dragState = useDragScroll(scrollerRef);

  useEffect(() => {
    if (!selectedId) {
      wasOpen.current = false;
      return; // closing: keep the content visible during the window fade-out
    }
    if (!wasOpen.current) {
      wasOpen.current = true;
      setDisplayedId(selectedId); // fresh open: the window's own fade covers it
      setPhase("idle");
      return;
    }
    if (selectedId === displayedId) return; // same node (e.g. a live edit)
    if (REDUCED_MOTION) {
      setDisplayedId(selectedId);
      return;
    }
    pendingId.current = selectedId; // newest target; dip the current content out first
    setPhase("out");
  }, [selectedId, displayedId]);

  // New content starts at the top, not wherever the previous view was scrolled.
  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [displayedId]);

  const onNavEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // ignore bubbled child animations
    if (phase === "out") {
      setDisplayedId(pendingId.current ?? selectedId); // swap at the trough
      pendingId.current = null;
      setPhase("in");
    } else if (phase === "in") {
      setPhase("idle");
    }
  };

  // Hover-out dismissal: the window is a transient surface, so leaving its area
  // closes it. A short grace timer absorbs diagonal/sub-pixel exits; entering
  // (back) cancels it. pointerleave does not fire when moving onto a descendant,
  // so hovering the embedded video iframe keeps the window open.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    // A scroll-drag that starts inside the content and crosses out into the exit
    // area is a scroll gesture, not an intent to leave: ignore the hover-out
    // while dragging, and briefly after it ends (the cursor may coast out as the
    // pinch releases).
    if (dragState.current.dragging || performance.now() - dragState.current.endedAt < 350) return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      clear();
    }, 120);
  };

  // Stabilize the camera cursor while a node is open: a wider deadzone holds it
  // still against hand tremor so reading is not disturbed (it otherwise slides
  // because inference slows under the open view's GPU/main-thread load).
  useEffect(() => {
    cameraPointer.setStabilize(open);
    return () => cameraPointer.setStabilize(false);
  }, [open]);

  // While a note is open it is the surface in front, so it claims both zoom and
  // pan rather than letting the canvas behind it move: once you have opened
  // something to read, "closer" means bigger content, not a bigger graph you
  // cannot see, and dragging means scrolling what you are reading. Zoom is
  // applied as CSS `zoom` on the content wrapper (see styles.css), the only
  // option that scales and reflows the way the browser's own zoom does.
  useEffect(() => {
    if (!open) return; // closed: never registered, so the graph keeps zoom
    return registerActionHandler((a) => {
      const el = scrollerRef.current;
      if (!el) return false;
      // A two-handed drag over an open note scrolls the note, rather than
      // panning a graph the note is covering.
      if (a.type === "pan") {
        // Sync from the real scrollTop before the first nudge: drag-scroll and
        // the wheel write it directly, so the spring must start from where the
        // content actually is or it would snap back to a stale value.
        if (!smoothing.current) scrollSpring.current.jump(el.scrollTop);
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        scrollSpring.current.setTarget(
          Math.min(max, Math.max(0, scrollSpring.current.goal - a.dy)),
        );
        startSmoothing();
        return true;
      }
      if (a.type !== "zoom") return false;
      const gain = a.pinch ? 0.0025 : 0.0004;
      scaleSpring.current.setTarget(
        Math.min(2.2, Math.max(0.7, scaleSpring.current.goal - a.delta * gain)),
      );
      startSmoothing();
      return true;
    }, PRIORITY.overlay);
  }, [open]);

  // Each note opens at its own default size rather than inheriting the last
  // one's, so a zoom is a local adjustment and not a sticky global setting.
  useEffect(() => {
    smoothing.current?.();
    smoothing.current = null;
    scaleSpring.current.jump(1);
    scrollSpring.current.jump(0);
    scrollerRef.current?.style.setProperty("--text-scale", "1");
  }, [displayedId]);

  // Esc closes the open view (a keyboard counterpart to hover-out / scrim click).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, clear]);

  const firstRun = useRef(true);
  useLayoutEffect(() => {
    const scrim = scrimRef.current;
    const frame = frameRef.current;
    if (!scrim || !frame) return;
    if (firstRun.current) {
      firstRun.current = false;
      if (!open) return; // already hidden by the CSS base state
    }
    if (REDUCED_MOTION) {
      scrim.style.opacity = open ? "1" : "0";
      frame.style.opacity = open ? "1" : "0";
      frame.style.transform = open ? "scale(1)" : "scale(0.94)";
      return;
    }
    // Track A: scale + fade resolved to keyframes, handed to the compositor. The
    // scrim (dim) and frame (window) fade on the same spring; the graph blur
    // ramps alongside via a CSS transition on .stage (see GraphView / styles).
    const scrimFrames = SLIDE.map((p) => ({ opacity: String(open ? p : 1 - p) }));
    const frameFrames = SLIDE.map((p) => {
      const t = open ? p : 1 - p; // 0 = closed, 1 = open
      return { opacity: String(t), transform: `scale(${0.94 + 0.06 * t})` };
    });
    scrim.animate(scrimFrames, { duration: SLIDE_MS, easing: "linear", fill: "forwards" });
    frame.animate(frameFrames, { duration: SLIDE_MS, easing: "linear", fill: "forwards" });
  }, [open]);

  return (
    <div className={`immersive-root${open ? " open" : ""}`}>
      <div className="immersive-scrim" ref={scrimRef} onClick={clear} />
      {/* Hover zone is the whole window frame, so the feathered side margins are a
          resting buffer: parking the cursor there keeps it open. Only leaving the
          frame (into the dimmed scrim) counts as hovering out. */}
      <div
        className="immersive-frame"
        ref={frameRef}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
      >
        <div className="immersive-bg" />
        <div className="immersive">
          <div
            className={`immersive-layer${phase === "idle" ? "" : ` ${phase}`}`}
            ref={scrollerRef}
            onAnimationEnd={onNavEnd}
          >
            {/* Reader zoom applies here, not on the scroller: the scroller keeps
                its own fixed box (inset 0) while the content inside grows and
                reflows, which is what makes scrollHeight follow the zoom. */}
            <div className="immersive-content">
              {(() => {
                if (displayedId?.startsWith('agent:')) {
                  const agent = agents.find(a => `agent:${a.instanceName}` === displayedId);
                  return agent && <><SpecialHeader kind="Agent" name={agent.instanceName} /><div className="ibody"><AgentBody agent={agent} tasks={tasks.filter(t => t.agentId === agent.instanceName)} select={select} /></div></>;
                }
                if (displayedId?.startsWith('task:')) {
                  const task = tasks.find(t => `task:${t.id}` === displayedId);
                  return task && <><SpecialHeader kind="Task" name={task.prompt} /><div className="ibody"><TaskBody task={task} select={select} /></div></>;
                }
                if (displayedId?.startsWith('artifact:')) {
                  const [, taskId, encodedPath] = displayedId.split(':');
                  const artifact = tasks.find(t => t.id === taskId)?.artifacts.find(a => encodeURIComponent(a.path) === encodedPath);
                  return artifact && <><SpecialHeader kind="Artifact" name={artifact.name} /><div className="ibody"><ArtifactBody artifact={artifact} /></div></>;
                }
                const d = displayedId ? getDetail(notes, displayedId) : null;
                if (!d) return null;
                return (
                  <>
                    <Header detail={d} />
                    <div className="ibody">
                      <Body detail={d} select={select} open={open} />
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function kindOf(d: Detail) {
  return d.kind === "note" ? "Note" : d.kind === "section" ? "Section" : "Link";
}

function nameOf(d: Detail) {
  if (d.kind === "note") return d.note.title;
  if (d.kind === "section") return d.section.heading ?? d.note.title;
  return hostname(d.url);
}

function Header({ detail }: { detail: Detail }) {
  return (
    <div className="ph">
      <div className={`badge ${detail.kind}`} />
      <div className="meta">
        <div className="kind">{kindOf(detail)}</div>
        <div className="nm">{nameOf(detail)}</div>
      </div>
    </div>
  );
}

function Body({
  detail,
  select,
  open,
}: {
  detail: Detail;
  select: (id: string) => void;
  open: boolean;
}) {
  if (detail.kind === "note") {
    return (
      <>
        {detail.note.sections.map((s) => (
          <div key={s.id}>
            {s.heading && (
              <button className="rowlink" onClick={() => select(s.id)}>
                {s.heading}
              </button>
            )}
            <ItemsAndUrls items={s.items} urls={s.urls} />
          </div>
        ))}
      </>
    );
  }

  if (detail.kind === "section") {
    return (
      <>
        <div className="sec">In note</div>
        <button className="rowlink" onClick={() => select(detail.note.id)}>
          {detail.note.title}
        </button>
        <ItemsAndUrls items={detail.section.items} urls={detail.section.urls} />
        {detail.section.content && (
          <>
            <div className="sec">Content</div>
            <pre className="content">{detail.section.content}</pre>
          </>
        )}
      </>
    );
  }

  // Only render the player while the panel is open, so closing unmounts it and
  // stops playback (we keep no memory of position; reopening starts fresh).
  const preview = open ? pickPreview(detail.url) : null;
  return (
    <>
      {preview && <PreviewFrame>{preview.render(detail.url)}</PreviewFrame>}
      <div className="sec">URL</div>
      <a className="prj" href={detail.url} target="_blank" rel="noreferrer">
        <span className="t">{detail.url}</span>
        <span className="arrow">↗</span>
      </a>
      {detail.refs.length > 0 && (
        <>
          <div className="sec">Referenced by</div>
          {detail.refs.map((r) => (
            <button key={r.id} className="rowlink" onClick={() => select(r.id)}>
              {r.label}
            </button>
          ))}
        </>
      )}
    </>
  );
}

function ItemsAndUrls({ items, urls }: { items: string[]; urls: string[] }) {
  return (
    <>
      {items.length > 0 && (
        <ul className="items">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
      {urls.length > 0 && (
        <div className="urls">
          {urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              {hostname(u)}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function SpecialHeader({ kind, name }: { kind: string; name: string }) {
  return <div className="ph"><div className={`badge ${kind.toLowerCase()}`} /><div className="meta"><div className="kind">{kind}</div><div className="nm">{name}</div></div></div>;
}
function AgentBody({ agent, tasks, select }: { agent: AgentInfo; tasks: AgentTask[]; select: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState<AgentLog | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => { fetch(`/api/agents/${encodeURIComponent(agent.instanceName)}/log`).then(r => r.json()).then(data => { if (live) setLog(data); }).catch(() => {}); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [agent.instanceName]);
  const reason = agent.kind !== 'cli' ? 'Desktop app has no non-interactive CLI' : !['codex', 'claude'].includes(agent.id) ? 'Task launch is not supported for this CLI yet' : '';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || sending || reason) return;
    setSending(true); setError('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.instanceName)}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start task');
      setPrompt('');
      await refreshTasks();
      select(`task:${data.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start task'); }
    finally { setSending(false); }
  };
  return <>
    <div className="sec">{agent.name} · {agent.kind}</div>
    <form className="agent-task-form" onSubmit={submit}>
      <label htmlFor="agent-task-input">Give {agent.instanceName} a task</label>
      <textarea id="agent-task-input" value={prompt} onChange={e => setPrompt(e.target.value)} disabled={!!reason || sending} placeholder={reason || 'Describe the task…'} />
      <button type="submit" disabled={!!reason || sending || !prompt.trim()}>Start task</button>
      {reason && <div className="task-hint">{reason}</div>}{error && <div className="task-error">{error}</div>}
    </form>
    <div className="sec">Tasks</div>
    {tasks.length ? tasks.map(t => <button key={t.id} className="rowlink" onClick={() => select(`task:${t.id}`)}>{t.status} · {t.prompt}</button>) : <p>No tasks yet.</p>}
    <div className="sec">Current or last session log</div>
    {log?.available ? <>
      {log.prompt && <><div className="task-hint">Last prompt · {log.prompt.at ?? ''}</div><p>{log.prompt.text}</p></>}
      {log.messages?.map((m, i) => <p key={i} className="log-line">{m.at ?? ''} · {m.text}</p>)}
      {log.tools?.length ? <><div className="sec">Recent tools</div>{log.tools.map((t, i) => <p key={i} className="log-line">{t.at ?? ''} · {t.name} ({t.args})</p>)}</> : null}
    </> : <p>{log?.reason ?? 'Loading log…'}</p>}
  </>;
}
function TaskBody({ task, select }: { task: AgentTask; select: (id: string) => void }) {
  return <><div className="sec">{task.status} · {task.updatedAt}</div><p>{task.prompt}</p>
    <button className="rowlink" onClick={() => select(`agent:${task.agentId}`)}>{task.agentId}</button>
    {task.artifacts.length > 0 && <div className="sec">Files</div>}
    {task.artifacts.map((a) => <button key={a.path} className="rowlink" onClick={() => select(`artifact:${task.id}:${encodeURIComponent(a.path)}`)}>{a.name}</button>)}
    {task.stdout && <><div className="sec">Output</div><pre className="content">{task.stdout}</pre></>}
    {task.stderr && <><div className="sec">Errors</div><pre className="content">{task.stderr}</pre></>}
  </>;
}
function ArtifactBody({ artifact }: { artifact: ArtifactInfo }) {
  const url = `/api/artifacts/file?path=${encodeURIComponent(artifact.path)}`;
  const open = () => { void fetch('/api/artifacts/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: artifact.path }) }); };
  return <><div className="sec">{artifact.type}</div><button className="rowlink" onClick={open}>Open in default app ↗</button><a className="prj" href={url} target="_blank" rel="noreferrer">Preview or download ↗</a>{artifact.type === 'image' && <img src={url} alt={artifact.name} className="artifact-preview" />}</>;
}

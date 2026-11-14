import { useEffect, useRef, useState, type CSSProperties } from "react";
import { VoiceSession, type VoiceStatus } from "../voice/VoiceSession";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";
import { CommandBuffer } from "../voice/CommandBuffer";
import { refreshAgents, refreshTasks } from "../state/agents";
import { useVault } from "../state/store";

export default function VoicePanel() {
  const session = useRef<VoiceSession>();
  const commands = useRef<CommandBuffer>();
  const mounted = useRef(true);
  const requestQueue = useRef(Promise.resolve());
  const clarificationContext = useRef("");
  const [assignment, setAssignment] = useState("");
  const [retry, setRetry] = useState<{ transcript: string; requestId: string }>();
  const [dispatching, setDispatching] = useState(false);
  const [assignedTask, setAssignedTask] = useState<string>();
  const transcriptView = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState("Enable your mic, then describe a task. OpenAI turns your words into a prompt for an idle agent.");
  const [segments, setSegments] = useState(emptyTranscript);
  const [level, setLevel] = useState(0);
  const [copied, setCopied] = useState(false);
  const active = ["armed", "loading", "listening", "stopping"].includes(status);
  const transcript = transcriptText(segments);
  const caption = status === "armed" ? "Speak when ready" : status === "listening" ? "Listening to you"
    : status === "loading" ? "Connecting…" : status === "stopping" ? "Finishing…"
    : status === "error" ? "Try again" : "Tap to speak";
  const showTranscript = Boolean(transcript) || Boolean(assignment) || status === "listening" || status === "error";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; commands.current?.dispose(); session.current?.dispose(); };
  }, []);
  useEffect(() => {
    const view = transcriptView.current;
    if (active && view) view.scrollTop = view.scrollHeight;
  }, [transcript, active]);

  function start() {
    commands.current?.dispose();
    session.current?.dispose();
    setSegments(emptyTranscript());
    setCopied(false);
    commands.current = new CommandBuffer((text) => enqueue({
      transcript: clarificationContext.current ? `${clarificationContext.current}\nAdditional clarification: ${text}` : text,
      requestId: crypto.randomUUID(),
    }));
    const next = new VoiceSession({
      status: (state, message) => { setStatus(state); setDetail(message ?? ""); },
      transcript: (event) => {
        setSegments((current) => updateTranscript(current, event));
        commands.current?.event(event);
      },
      activity: (energy, speaking) => { setLevel(energy); commands.current?.activity(speaking); },
    });
    session.current = next;
    void next.start();
  }

  function enqueue(request: { transcript: string; requestId: string }) {
    requestQueue.current = requestQueue.current.then(async () => {
      if (!mounted.current) return;
      setDispatching(true); setRetry(undefined); setAssignedTask(undefined);
      setAssignment("Understanding your task and finding an idle agent…");
      try {
        const response = await fetch('/api/voice/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not delegate the task.');
        if (!mounted.current) return;
        if (data.state === 'assigned') {
          clarificationContext.current = '';
          setAssignment(data.task.status === 'failed' ? `${data.task.agentId} could not start. Open the task for details.` : `${data.task.agentId}: ${data.intent.objective}`);
          setAssignedTask(data.task.id);
          await Promise.all([refreshAgents(), refreshTasks()]);
        } else if (data.state === 'clarify') {
          clarificationContext.current = request.transcript;
          setAssignment(data.intent.clarification);
        }
        else setAssignment('No task detected. Describe what you want an agent to do.');
      } catch (error) {
        if (!mounted.current) return;
        setAssignment(error instanceof Error ? error.message : 'Could not delegate the task.');
        setRetry(request);
      } finally { if (mounted.current) setDispatching(false); }
    });
  }

  async function copy() {
    try { await navigator.clipboard.writeText(transcript); setCopied(true); }
    catch { setDetail("Copy was blocked. Select the transcript and copy it manually."); }
  }

  return (
    <section className={`voice-dock ${status}`} aria-label="Voice transcription"
      style={{ "--voice-level": level } as CSSProperties}>
      {showTranscript && <div className="voice-panel">
        <div className="voice-toolbar">
          <label className="voice-label" htmlFor="voice-transcript">Live transcript</label>
          <span>OpenAI</span>
        </div>
        <textarea ref={transcriptView} id="voice-transcript" readOnly value={transcript}
          placeholder="Your words will appear here…" />
        <div className="voice-footer">
          <span>Voice → idle agent</span>
          <button type="button" disabled={!transcript} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <button type="button" disabled={!transcript || active} onClick={() => { setSegments(emptyTranscript()); setCopied(false); }}>Clear</button>
        </div>
        {assignment && <p className="voice-assignment" role="status">{assignment}</p>}
        {retry && <button type="button" disabled={dispatching} onClick={() => enqueue(retry)}>Retry task</button>}
        {assignedTask && <button type="button" onClick={() => useVault.getState().select(`task:${assignedTask}`)}>View task</button>}
      </div>}
      <div className="voice-marble-float">
        <button type="button" className="voice-marble" disabled={status === "stopping"}
          aria-label={active ? "Turn off microphone" : "Enable voice detection"}
          aria-pressed={active} aria-describedby="voice-detail"
          onClick={() => active ? session.current?.stop() : start()}>
          <span className="voice-halo" aria-hidden="true" />
          <span className="voice-sphere" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6" />
            </svg>
          </span>
        </button>
      </div>
      <div className="voice-caption" role="status">{caption}</div>
      <p id="voice-detail" className="voice-help" role={status === "error" ? "alert" : undefined}>{detail}</p>
      {active && <button className="voice-off" type="button" disabled={status === "stopping"}
        onClick={() => session.current?.stop()}>Turn mic off</button>}
    </section>
  );
}

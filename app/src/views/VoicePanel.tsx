import { useEffect, useRef, useState, type CSSProperties } from "react";
import { VoiceSession, type VoiceStatus } from "../voice/VoiceSession";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";
import { CommandBuffer } from "../voice/CommandBuffer";
import { refreshAgents, refreshTasks, refreshSwarms, useAgents } from "../state/agents";
import VoiceConversation from "./VoiceConversation";
import { upsertMessage, visibleMessages, statusMessage, type VoiceMessage, type VoiceRequest } from "../voice/messages";
import { ReplySpeaker } from '../voice/ReplySpeaker';
import { withoutWakePhrase } from '../voice/wakePhrase';

export default function VoicePanel() {
  const session = useRef<VoiceSession>();
  const speaker = useRef<ReplySpeaker>();
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [replyPlaying, setReplyPlaying] = useState(false);
  const commands = useRef<CommandBuffer>();
  const mounted = useRef(true);
  const requestQueue = useRef(Promise.resolve());
  const clarificationContext = useRef("");
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [now, setNow] = useState(Date.now());
  const pausedAt = useRef<number>();
  const draft = useRef(emptyTranscript());
  const consumed = useRef(new Set<string>());
  const draftId = useRef('');
  const watching = useRef(new Map<string, string>());
  const tasks = useAgents(state => state.tasks);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState("Enable your mic, then describe a task. OpenAI turns your words into a prompt for an idle agent.");
  const [level, setLevel] = useState(0);
  const active = ["wake", "armed", "loading", "listening", "stopping"].includes(status);
  const caption = replyPlaying ? 'Speaking · AI voice' : status === 'wake' ? 'Say “Marbles”' : status === "armed" ? "What can I do for you?" : status === "listening" ? "Listening to you"
    : status === "loading" ? detail.startsWith('Downloading local wake model:') ? detail.replace('Downloading local wake model:', 'Wake model:') : 'Starting voice…' : status === "stopping" ? "Finishing…"
    : status === "error" ? "Enable microphone" : "Microphone off";


  useEffect(() => {
    mounted.current = true;
    speaker.current = new ReplySpeaker({
      active: playing => { setReplyPlaying(playing); session.current?.setReplyPlaying(playing); },
      error: text => message({ id: 'speech-error', role: 'assistant', text }),
    });
    speaker.current.setEnabled(voiceReplies);
    // Delay one event loop so StrictMode's initial cleanup cancels its trial
    // mount before requesting microphone access or loading the wake model.
    const startup = setTimeout(start, 0);
    return () => { clearTimeout(startup); mounted.current = false; commands.current?.dispose(); session.current?.dispose(); speaker.current?.dispose(); };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pausedAt.current != null) return;
      const time = Date.now(); setNow(time);
      setMessages(current => visibleMessages(current, time));
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    for (const task of tasks) {
      if (task.status === 'running' && task.source === 'voice' && !watching.current.has(task.id)) {
        watching.current.set(task.id, task.title ?? 'your task');
      }
      if (!watching.current.has(task.id) || task.status === 'running') continue;
      watching.current.delete(task.id);
      const text = task.status === 'failed' ? `I couldn’t finish: ${task.title ?? 'the task'}. Open the task for details.`
        : task.stdout.trim().slice(-900) || `Finished: ${task.title ?? 'your task'}.${task.artifacts.length ? ` ${task.artifacts.length} files ready.` : ''}`;
      message({ id: `result:${task.id}`, role: 'assistant', label: task.agentId, text, taskId: task.id });
    }
  }, [tasks]);

  function message(item: Omit<VoiceMessage, 'expiresAt'>) {
    const time = Date.now(); setNow(time);
    setMessages(current => upsertMessage(current, item, time));
    if (item.role === 'assistant' && !item.pending && item.id !== 'speech-error') speaker.current?.enqueue(item.id, item.text);
  }
  function pause() { pausedAt.current ??= Date.now(); }
  function resume() {
    if (pausedAt.current == null) return;
    const elapsed = Date.now() - pausedAt.current;
    setMessages(current => current.map(item => ({ ...item, expiresAt: item.expiresAt + elapsed })));
    pausedAt.current = undefined;
  }

  function start() {
    commands.current?.dispose();
    speaker.current?.interrupt();
    session.current?.dispose();
    draft.current = emptyTranscript();
    consumed.current.clear();
    draftId.current = crypto.randomUUID();
    commands.current = new CommandBuffer(text => {
      message({ id: draftId.current, role: 'user', text });
      for (const id of Object.keys(draft.current.items)) consumed.current.add(id);
      draft.current = emptyTranscript(); draftId.current = crypto.randomUUID();
      const request = withoutWakePhrase(text);
      if (!request) {
        message({ id: `wake-reply:${crypto.randomUUID()}`, role: 'assistant', text: "I’m listening. What would you like me to do?" });
        return; // A standalone wake phrase gets a reply without launching a task.
      }
      enqueue({ transcript: clarificationContext.current ? `${clarificationContext.current}\nAdditional clarification: ${request}` : request,
        requestId: crypto.randomUUID() });
    });
    const next = new VoiceSession({
      status: (state, detail) => {
        setStatus(state); setDetail(detail ?? "");
        if (state === 'error') {
          const text = transcriptText(draft.current);
          if (text) message({ id: draftId.current, role: 'user', text });
          message({ id: 'microphone-error', role: 'assistant', text: detail ?? 'Microphone error.' });
        }
      },
      transcript: (event) => {
        if (event.item_id && !consumed.current.has(event.item_id)) {
          draft.current = updateTranscript(draft.current, event);
          const text = transcriptText(draft.current);
          if (text) message({ id: draftId.current, role: 'user', text, pending: true });
        }
        commands.current?.event(event);
      },
      activity: (energy, speaking) => { setLevel(energy); commands.current?.activity(speaking); speaker.current?.setUserSpeaking(speaking); },
      awake: () => speaker.current?.interrupt(),
    }, { wake: true });
    session.current = next;
    void next.start();
  }

  function enqueue(request: VoiceRequest) {
    requestQueue.current = requestQueue.current.then(async () => {
      if (!mounted.current) return;
      const id = `reply:${request.requestId}`;
      const reply = (text: string, extra: Partial<VoiceMessage> = {}) => message({ id, role: 'assistant', text, ...extra });
      reply('Finding the right agent…', { pending: true });
      try {
        const response = await fetch('/api/voice/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not delegate the task.');
        if (!mounted.current) return;
        if (data.state === 'assigned') {
          session.current?.rearm();
          clarificationContext.current = '';
          watching.current.set(data.task.id, data.intent.objective);
          reply(data.task.status === 'failed' ? `${data.task.agentId} could not start. Open the task for details.` : `Handed to ${data.task.agentId}: ${data.intent.objective}`, { taskId: data.task.id });
          await Promise.all([refreshAgents(), refreshTasks()]);
        } else if (data.state === 'swarm') {
          session.current?.rearm(); clarificationContext.current = '';
          reply(`Started a swarm with ${data.swarm.agents.join(' and ')}: ${data.intent.objective}`, { swarmId: data.swarm.id });
          await Promise.all([refreshAgents(), refreshSwarms()]);
        } else if (data.state === 'status' || data.state === 'log') {
          session.current?.rearm(); clarificationContext.current = '';
          const item = statusMessage(id, data);
          if (item) message(item);
        } else if (data.state === 'clarify') {
          clarificationContext.current = request.transcript;
          reply(data.intent.clarification);
        }
        else reply('What would you like me to do?');
      } catch (error) {
        if (!mounted.current) return;
        reply(error instanceof Error ? error.message : 'Could not delegate the task.', { retry: request });
      }
    });
  }

  return (
    <>
    <VoiceConversation messages={messages} now={now} pause={pause} resume={resume} retry={enqueue}
      read={text => { speaker.current?.setEnabled(true); setVoiceReplies(true); speaker.current?.enqueue(crypto.randomUUID(), text); }} />
    <section className={`voice-dock ${status}${replyPlaying ? ' reply-speaking' : ''}`} aria-label="Voice transcription"
      style={{ "--voice-level": level } as CSSProperties}>
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
      <button className="voice-off" type="button" aria-pressed={voiceReplies} onClick={() => {
        const enabled = !voiceReplies; setVoiceReplies(enabled); speaker.current?.setEnabled(enabled);
      }}>{voiceReplies ? 'AI voice on' : 'AI voice muted'}</button>
      {replyPlaying && <button className="voice-off" type="button" onClick={() => speaker.current?.interrupt()}>Stop reply</button>}
      <p id="voice-detail" className="voice-sr-only" role={status === "error" ? "alert" : undefined}>{detail}</p>
      {active && <button className="voice-off" type="button" disabled={status === "stopping"}
        onClick={() => session.current?.stop()}>Turn mic off</button>}
    </section>
    </>
  );
}

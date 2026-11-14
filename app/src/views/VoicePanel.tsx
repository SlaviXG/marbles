import { useEffect, useRef, useState, type CSSProperties } from "react";
import { VoiceSession, type VoiceStatus } from "../voice/VoiceSession";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";
import { CommandBuffer } from "../voice/CommandBuffer";
import { refreshAgents, refreshTasks, refreshSwarms, useAgents } from "../state/agents";
import VoiceConversation from "./VoiceConversation";
import { upsertMessage, visibleMessages, type VoiceMessage, type VoiceRequest } from "../voice/messages";
import { ReplySpeaker } from '../voice/ReplySpeaker';
import { withoutWakePhrase } from '../voice/wakePhrase';
import { useVault } from '../state/store';
import type { AgentTask, SwarmTask } from '../core/agentTypes';
import { DEFAULT_SPEECH_VOICE, SPEECH_VOICES, type SpeechVoice } from '../../shared/speechVoices.mjs';

export default function VoicePanel() {
  const session = useRef<VoiceSession>();
  const speaker = useRef<ReplySpeaker>();
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [speechVoice, setSpeechVoice] = useState<SpeechVoice>(DEFAULT_SPEECH_VOICE);
  const [ttsProvider, setTtsProvider] = useState<'elevenlabs' | 'openai' | 'none'>();
  const [replyPlaying, setReplyPlaying] = useState(false);
  const commands = useRef<CommandBuffer>();
  const mounted = useRef(true);
  const requestQueue = useRef(Promise.resolve());
  const conversationId = useRef(crypto.randomUUID());
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [now, setNow] = useState(Date.now());
  const pausedAt = useRef<number>();
  const draft = useRef(emptyTranscript());
  const consumed = useRef(new Set<string>());
  const draftId = useRef('');
  const watching = useRef(new Map<string, string>());
  const watchingSwarms = useRef(new Set<string>());
  const tasks = useAgents(state => state.tasks);
  const swarms = useAgents(state => state.swarms);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState("Describe the outcome. Marbles plans it and delegates to an idle agent.");
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
    speaker.current.setVoice(speechVoice);
    // Delay one event loop so StrictMode's initial cleanup cancels its trial
    // mount before requesting microphone access or loading the wake model.
    const startup = setTimeout(start, 0);
    return () => { clearTimeout(startup); mounted.current = false; commands.current?.dispose(); session.current?.dispose(); speaker.current?.dispose(); };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/voice/tts-info', { signal: abort.signal })
      .then(response => response.ok ? response.json() : null)
      .then(info => {
        if (!abort.signal.aborted && ['elevenlabs', 'openai', 'none'].includes(info?.provider)) {
          setTtsProvider(info.provider);
        }
      }).catch(() => { /* The voice controls still work if provider info is unavailable. */ });
    return () => abort.abort();
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
      if (['running', 'cancelling'].includes(task.status) && task.source === 'voice' && !watching.current.has(task.id)) {
        watching.current.set(task.id, task.title ?? 'your task');
      }
      if (!watching.current.has(task.id) || ['running', 'cancelling'].includes(task.status)) continue;
      watching.current.delete(task.id);
      void reportResult(task, 'task');
    }
  }, [tasks]);

  useEffect(() => {
    for (const swarm of swarms) {
      if (['running', 'evaluating'].includes(swarm.status) && swarm.source === 'voice') watchingSwarms.current.add(swarm.id);
      if (!watchingSwarms.current.has(swarm.id) || ['running', 'evaluating'].includes(swarm.status)) continue;
      watchingSwarms.current.delete(swarm.id);
      void reportResult(swarm, 'swarm');
    }
  }, [swarms]);

  async function reportResult(record: AgentTask | SwarmTask, kind: 'task' | 'swarm') {
    let text = record.status === 'cancelled' ? `Stopped: ${(record.title ?? 'your task').slice(0, 100)}.`
      : record.status === 'completed' ? `Finished: ${(record.title ?? 'your task').slice(0, 100)}. Open the task for the result.`
      : `Couldn’t finish: ${(record.title ?? 'your task').slice(0, 100)}. Open the task for details.`;
    try {
      const response = await fetch('/api/voice/result', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id, kind, conversationId: conversationId.current }), signal: AbortSignal.timeout(55_000) });
      if (response.ok) { const data = await response.json(); if (typeof data.reply === 'string' && data.reply.trim()) text = data.reply; }
    } catch { /* A short local notice keeps results usable if synthesis fails. */ }
    if (mounted.current) message({ id: `result:${kind}:${record.id}`, role: 'assistant', label: 'Marbles · Hermes', text,
      ...(kind === 'task' ? { taskId: record.id } : { swarmId: record.id }) });
  }

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
        message({ id: `wake-reply:${crypto.randomUUID()}`, role: 'assistant', text: 'Ready.' });
        return; // A standalone wake phrase gets a reply without launching a task.
      }
      enqueue({ transcript: request, requestId: crypto.randomUUID(), conversationId: conversationId.current, selectedId: useVault.getState().selectedId });
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
      const reply = (text: string, extra: Partial<VoiceMessage> = {}) => message({ id, role: 'assistant', label: 'Marbles · Hermes', text, ...extra });
      reply('Planning…', { pending: true });
      try {
        const response = await fetch('/api/voice/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(55_000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not delegate the task.');
        if (!mounted.current) return;
        if (data.state === 'assigned') {
          session.current?.rearm();
          watching.current.set(data.task.id, data.intent.objective);
          reply(data.reply, { taskId: data.task.id, plan: data.intent });
          await Promise.all([refreshAgents(), refreshTasks()]);
        } else if (data.state === 'swarm') {
          session.current?.rearm(); watchingSwarms.current.add(data.swarm.id);
          reply(data.reply, { swarmId: data.swarm.id, plan: data.intent });
          await Promise.all([refreshAgents(), refreshSwarms()]);
        } else if (data.state === 'ignore') {
          setMessages(current => current.filter(item => item.id !== id)); session.current?.rearm();
        } else {
          reply(data.reply);
          if (data.state !== 'clarify') session.current?.rearm();
        }
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
      {ttsProvider && <div className="voice-provider">Speech: {ttsProvider === 'elevenlabs' ? 'ElevenLabs' : ttsProvider === 'openai' ? 'OpenAI' : 'unavailable'}</div>}
      <label className="voice-picker">OpenAI fallback voice
        <select value={speechVoice} onChange={event => {
          const voice = event.target.value as SpeechVoice;
          setSpeechVoice(voice); speaker.current?.setVoice(voice);
        }}>
          {SPEECH_VOICES.map(voice => <option key={voice} value={voice}>{voice}</option>)}
        </select>
      </label>
      {replyPlaying && <button className="voice-off" type="button" onClick={() => speaker.current?.interrupt()}>Stop reply</button>}
      <p id="voice-detail" className="voice-sr-only" role={status === "error" ? "alert" : undefined}>{detail}</p>
      {active && <button className="voice-off" type="button" disabled={status === "stopping"}
        onClick={() => session.current?.stop()}>Turn mic off</button>}
    </section>
    </>
  );
}

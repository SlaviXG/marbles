import { useEffect, useRef, useState } from "react";
import { VoiceSession, type VoiceStatus } from "../voice/VoiceSession";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";
import { CommandBuffer } from "../voice/CommandBuffer";
import { refreshAgents, refreshTasks, refreshSwarms, useAgents } from "../state/agents";
import VoiceConversation from "./VoiceConversation";
import { upsertMessage, type VoiceMessage, type VoiceRequest } from "../voice/messages";
import { ReplySpeaker } from '../voice/ReplySpeaker';
import { withoutWakePhrase } from '../voice/wakePhrase';
import { canvasCommand } from '../voice/canvasCommand';
import { useVault } from '../state/store';
import type { AgentTask, SwarmTask } from '../core/agentTypes';
import { useHud, voiceSignal } from '../state/hud';
import VoiceCore from './VoiceCore';

export default function VoicePanel({ onActivate, onDeactivate }: { onActivate?: () => void; onDeactivate?: () => void } = {}) {
  const session = useRef<VoiceSession>();
  const speaker = useRef<ReplySpeaker>();
  const [voiceReplies] = useState(true);
  const [replyPlaying, setReplyPlaying] = useState(false);
  const commands = useRef<CommandBuffer>();
  const mounted = useRef(true);
  const requestQueue = useRef(Promise.resolve());
  const conversationId = useRef(crypto.randomUUID());
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const draft = useRef(emptyTranscript());
  const consumed = useRef(new Set<string>());
  const draftId = useRef('');
  const watching = useRef(new Map<string, string>());
  const watchingSwarms = useRef(new Set<string>());
  const tasks = useAgents(state => state.tasks);
  const swarms = useAgents(state => state.swarms);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState("Describe the outcome. Marbles plans it and delegates to an idle agent.");
  const active = ["wake", "armed", "loading", "listening", "stopping"].includes(status);
  const caption = replyPlaying ? '' : status === 'wake' ? 'Say “Marbles”' : status === "armed" ? "Go ahead" : status === "listening" ? "Listening"
    : status === "loading" ? detail.startsWith('Downloading local wake model:') ? detail.replace('Downloading local wake model:', 'Wake model') : 'Waking up' : status === "stopping" ? "Standing down"
    : status === "error" ? "Tap to retry" : "Tap to wake";
  useEffect(() => { useHud.getState().setVoice(status); }, [status]);
  useEffect(() => { useHud.getState().setSpeaking(replyPlaying); }, [replyPlaying]);
  useEffect(() => () => { voiceSignal.level = 0; useHud.getState().setVoice('idle'); useHud.getState().setSpeaking(false); }, []);


  useEffect(() => {
    mounted.current = true;
    speaker.current = new ReplySpeaker({
      active: playing => { setReplyPlaying(playing); session.current?.setReplyPlaying(playing); },
      error: text => message({ id: 'speech-error', role: 'assistant', text }),
    });
    speaker.current.setEnabled(voiceReplies);
    return () => { mounted.current = false; commands.current?.dispose(); session.current?.dispose(); speaker.current?.dispose(); onDeactivate?.(); };
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
    const time = Date.now();
    setMessages(current => upsertMessage(current, item, time));
    if (item.role === 'assistant' && !item.pending && item.id !== 'speech-error') speaker.current?.enqueue(item.id, item.text);
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
        return;
      }
      const local = canvasCommand(request, useAgents.getState().tasks, useAgents.getState().swarms);
      if (local) {
        if (local.close) useVault.getState().clear();
        if (local.select) useVault.getState().select(local.select);
        message({ id: `canvas:${crypto.randomUUID()}`, role: 'assistant', text: local.reply });
        session.current?.rearm();
        return;
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
      activity: (energy, speaking) => { voiceSignal.level = energy; commands.current?.activity(speaking); speaker.current?.setUserSpeaking(speaking); },
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
    <VoiceConversation messages={messages} retry={enqueue} />
    <section className={`voice-dock ${status}${replyPlaying ? ' reply-speaking' : ''}`} aria-label="Voice control">
      <button type="button" className="voice-marble" disabled={status === "stopping"}
        aria-label={active ? "Pause voice and hand control" : "Enable voice and hand control"}
        aria-pressed={active} aria-describedby="voice-detail"
        onClick={() => { if (active) { session.current?.stop(); voiceSignal.level = 0; onDeactivate?.(); } else { start(); onActivate?.(); } }}>
        <VoiceCore />
        <svg className="voice-mic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3" />
        </svg>
      </button>
      <div className="voice-caption" role="status" key={caption}>{caption}</div>
      <p id="voice-detail" className={status === 'error' ? 'voice-help' : 'voice-sr-only'} role={status === 'error' ? 'alert' : undefined}>{status === 'error' ? detail : 'Touch the orb to enable microphone and camera. Say Marbles, then your task. Requests start when you finish speaking. Transcription uses OpenAI. Touch again to pause.'}</p>
    </section>
    </>
  );
}

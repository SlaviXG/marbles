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
import { mediaCommand } from '../voice/mediaCommand';
import { setDucked } from '../voice/ducking';
import { describeScreen, shareScreen } from '../state/screen';
import { useAttention } from '../attention/AttentionTracker';
import { useDisplay, type Display } from '../state/display';
import { usePresentation } from '../state/presentation';
import { artifactSelection } from '../core/presentation';
import { useVault } from '../state/store';
import type { AgentTask, SwarmTask } from '../core/agentTypes';
import { useHud, voiceSignal } from '../state/hud';
import VoiceCore from './VoiceCore';

export default function VoicePanel({ onActivate, onDeactivate }: { onActivate?: () => void; onDeactivate?: () => void } = {}) {
  const session = useRef<VoiceSession>();
  const speaker = useRef<ReplySpeaker>();
  const [voiceReplies] = useState(true);
  const [replyPlaying, setReplyPlaying] = useState(false);
  const [wakePulse, setWakePulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout>>();
  const commands = useRef<CommandBuffer>();
  const mounted = useRef(true);
  const backlog = useRef<VoiceRequest[]>([]);
  const flying = useRef(false);
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
  // Anything the app is playing steps back while you are heard or answered.
  useEffect(() => { setDucked(replyPlaying || status === 'armed' || status === 'listening'); return () => setDucked(false); }, [status, replyPlaying]);
  // Looking at the screen opens the microphone; only a known answer is passed on.
  const attention = useAttention(state => state.status);
  useEffect(() => {
    session.current?.setAttention(attention === 'looking' ? true : attention === 'away' || attention === 'nobody' ? false : null);
  }, [attention, status === 'idle' || status === 'loading']);
  useEffect(() => { useHud.getState().setSpeaking(replyPlaying); }, [replyPlaying]);
  useEffect(() => () => { voiceSignal.level = 0; useHud.getState().setVoice('idle'); useHud.getState().setSpeaking(false); }, []);


  useEffect(() => {
    mounted.current = true;
    speaker.current = new ReplySpeaker({
      active: playing => { setReplyPlaying(playing); session.current?.setReplyPlaying(playing); },
      error: text => message({ id: 'speech-error', role: 'assistant', text }),
    });
    speaker.current.setEnabled(voiceReplies);
    return () => { mounted.current = false; clearTimeout(pulseTimer.current); commands.current?.dispose(); session.current?.dispose(); speaker.current?.dispose(); onDeactivate?.(); };
  }, []);
  useEffect(() => {
    for (const task of tasks) {
      if (['queued', 'running', 'cancelling'].includes(task.status) && task.source === 'voice' && !watching.current.has(task.id)) {
        watching.current.set(task.id, task.title ?? 'your task');
      }
      if (!watching.current.has(task.id) || ['queued', 'running', 'cancelling'].includes(task.status)) continue;
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
      const media = mediaCommand(request, useDisplay.getState().display, !!useDisplay.getState().video);
      if (media) {
        const view = useDisplay.getState();
        if (media.action === 'confirm') void view.confirm();
        else if (media.action === 'close') view.close();
        else if (media.action === 'closeVideo') view.closeVideo();
        else if (media.action === 'bigger' || media.action === 'smaller') view.resizeVideo(media.action === 'bigger');
        else if (media.action === 'grid') view.focus(null);
        else view.step(media.action === 'next' ? 1 : -1);
        if (media.reply) message({ id: `media:${crypto.randomUUID()}`, role: 'assistant', text: media.reply });
        session.current?.rearm();
        return;
      }
      const local = canvasCommand(request, useAgents.getState().tasks, useAgents.getState().swarms, useAgents.getState().agents.filter(agent => agent.codingAgent),
        usePresentation.getState().queue[0] ? artifactSelection(usePresentation.getState().queue[0]) : null);
      if (local) {
        if (local.close || local.select) useDisplay.getState().close();
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
          useDisplay.getState().report(`Voice stopped: ${detail ?? 'microphone error'}`);
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
      // What was heard was the room, not a request: take the half-written line away.
      discard: () => {
        const id = draftId.current;
        for (const item of Object.keys(draft.current.items)) consumed.current.add(item);
        draft.current = emptyTranscript(); draftId.current = crypto.randomUUID();
        setMessages(current => current.filter(item => item.id !== id));
      },
      wakeDetected: () => {
        setWakePulse(false);
        requestAnimationFrame(() => setWakePulse(true));
        clearTimeout(pulseTimer.current);
        pulseTimer.current = setTimeout(() => setWakePulse(false), 600);
      },
    }, { wake: true });
    session.current = next;
    void next.start();
  }

  // One request is with Hermes at a time. Anything said meanwhile waits here
  // and goes out together when it returns: the newest as the request, the
  // rest as "earlier", so the latest thing has priority and nothing is lost.
  function enqueue(request: VoiceRequest) {
    backlog.current.push(request);
    if (!flying.current) void flush();
  }
  async function flush() {
    flying.current = true;
    try {
      while (backlog.current.length && mounted.current) {
        const waiting = backlog.current.splice(0);
        const newest = waiting[waiting.length - 1];
        await send({ ...newest, earlier: [...waiting.slice(0, -1).flatMap(item => [...(item.earlier ?? []), item.transcript])].slice(-6) });
      }
    } finally { flying.current = false; }
  }
  async function send(request: VoiceRequest) {
    await (async () => {
      if (!mounted.current) return;
      const id = `reply:${request.requestId}`;
      const replyFirst = (text: string, extra: Partial<VoiceMessage> = {}) => message({ id, role: 'assistant', label: 'Marbles · Hermes', text, ...extra });
      const reply = replyFirst;
      reply('Planning…', { pending: true });
      try {
        // Marbles knows what is on screen: a short description goes with the
        // request, and a picture is left with the local server in case it must look.
        await shareScreen();
        const response = await fetch('/api/voice/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, screen: describeScreen() }), signal: AbortSignal.timeout(150_000),
        });
        const first = await response.json();
        if (!response.ok) throw new Error(first.error || 'Could not delegate the task.');
        if (!mounted.current) return;
        // The reply to the newest request, then to anything picked up from earlier.
        for (const [turn, data] of [first, ...(first.followUp ? [first.followUp] : [])].entries()) {
        const reply = turn ? (text: string, extra: Partial<VoiceMessage> = {}) => message({ id: `${id}:earlier`, role: 'assistant', label: 'Marbles · Hermes', text, ...extra }) : replyFirst;
        if (data.state === 'assigned') {
          session.current?.rearm();
          // One sentence can hold several tasks; follow every one of them.
          for (const [n, task] of ((data.tasks ?? [data.task]) as AgentTask[]).entries()) watching.current.set(task.id, data.intents?.[n]?.objective ?? data.intent.objective);
          reply(data.reply, { taskId: data.task.id, plan: data.intent });
          await Promise.all([refreshAgents(), refreshTasks()]);
        } else if (data.state === 'swarm') {
          session.current?.rearm(); watchingSwarms.current.add(data.swarm.id);
          reply(data.reply, { swarmId: data.swarm.id, plan: data.intent });
          await Promise.all([refreshAgents(), refreshSwarms()]);
        } else if (data.state === 'show' && data.display) {
          // Hermes chose to put something in front of the user.
          const shown = data.display as Display | { kind: 'select'; id: string } | { kind: 'close' };
          if (shown.kind === 'select') { useDisplay.getState().close(); useVault.getState().select(shown.id); }
          else if (shown.kind === 'close') { useDisplay.getState().close(); useVault.getState().clear(); }
          else if (shown.kind === 'video') useDisplay.getState().show(shown); // a side window: whatever is open stays open
          else { useVault.getState().clear(); useDisplay.getState().show(shown); }
          reply(data.reply);
          session.current?.rearm();
        } else if (data.state === 'ignore') {
          setMessages(current => current.filter(item => item.id !== id)); session.current?.rearm();
        } else {
          reply(data.reply);
          if (data.state !== 'clarify') session.current?.rearm();
        }
        }
      } catch (error) {
        if (!mounted.current) return;
        reply(error instanceof Error ? error.message : 'Could not delegate the task.', { retry: request });
        useDisplay.getState().report(`A request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    })();
  }

  return (
    <>
    <VoiceConversation messages={messages} retry={enqueue} />
    <section className={`voice-dock ${status}${replyPlaying ? ' reply-speaking' : ''}${wakePulse ? ' wake-detected' : ''}`} aria-label="Voice control">
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
      <p id="voice-detail" className={status === 'error' ? 'voice-help' : 'voice-sr-only'} role={status === 'error' ? 'alert' : undefined}>{status === 'error' ? detail : 'Touch the orb to enable microphone and camera. Say Marbles, then your task. Requests start when you finish speaking. Browser-assisted wake recognition may use your browser’s speech service. Command transcription uses OpenAI. Touch again to pause.'}</p>
    </section>
    </>
  );
}

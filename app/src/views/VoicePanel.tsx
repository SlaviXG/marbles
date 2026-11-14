import { useEffect, useRef, useState } from "react";
import { VoiceSession, type VoiceStatus } from "../voice/VoiceSession";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";

export default function VoicePanel() {
  const session = useRef<VoiceSession>();
  const transcriptView = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState("English live transcription using OpenAI. Starting sends microphone audio to OpenAI.");
  const [segments, setSegments] = useState(emptyTranscript);
  const [copied, setCopied] = useState(false);
  const active = status === "loading" || status === "listening" || status === "stopping";
  const transcript = transcriptText(segments);

  useEffect(() => () => session.current?.dispose(), []);
  useEffect(() => {
    const view = transcriptView.current;
    if (active && view) view.scrollTop = view.scrollHeight;
  }, [transcript, active]);

  function start() {
    session.current?.dispose();
    setSegments(emptyTranscript());
    setCopied(false);
    const next = new VoiceSession({
      status: (state, message) => { setStatus(state); setDetail(message ?? ""); },
      transcript: (event) => setSegments((current) => updateTranscript(current, event)),
    });
    session.current = next;
    void next.start();
  }

  async function copy() {
    try { await navigator.clipboard.writeText(transcript); setCopied(true); }
    catch { setDetail("Copy was blocked. Select the transcript and copy it manually."); }
  }

  return (
    <section className="voice-panel" aria-labelledby="voice-heading">
      <div className="voice-toolbar">
        <h2 id="voice-heading">Voice</h2>
        <span className={`voice-state ${status}`} role="status">{status === "idle" ? "Ready" : status}</span>
        <button type="button" className={active ? "voice-record active" : "voice-record"}
          disabled={status === "stopping"} aria-pressed={active}
          onClick={() => active ? session.current?.stop() : start()}>
          {status === "loading" ? "Cancel" : active ? "Stop microphone" : "Start microphone"}
        </button>
      </div>
      <p className="voice-help" role={status === "error" ? "alert" : undefined}>{detail}</p>
      <label className="voice-label" htmlFor="voice-transcript">Live transcript</label>
      <textarea ref={transcriptView} id="voice-transcript" readOnly value={transcript}
        placeholder="Your words will appear here as you speak." />
      <div className="voice-footer">
        <span>OpenAI · Preview only</span>
        <button type="button" disabled={!transcript || active} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" disabled={!transcript || active} onClick={() => { setSegments(emptyTranscript()); setCopied(false); }}>Clear</button>
      </div>
    </section>
  );
}

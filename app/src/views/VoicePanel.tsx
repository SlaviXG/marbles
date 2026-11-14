import { useEffect, useRef, useState, type CSSProperties } from "react";
import { VoiceSession, type VoiceStatus } from "../voice/VoiceSession";
import { emptyTranscript, transcriptText, updateTranscript } from "../voice/transcript";

export default function VoicePanel() {
  const session = useRef<VoiceSession>();
  const transcriptView = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState("Enable your microphone once, then speak naturally. Detected audio goes to OpenAI.");
  const [segments, setSegments] = useState(emptyTranscript);
  const [level, setLevel] = useState(0);
  const [copied, setCopied] = useState(false);
  const active = ["armed", "loading", "listening", "stopping"].includes(status);
  const transcript = transcriptText(segments);
  const caption = status === "armed" ? "Speak when ready" : status === "listening" ? "Listening to you"
    : status === "loading" ? "Connecting…" : status === "stopping" ? "Finishing…"
    : status === "error" ? "Try again" : "Tap to speak";
  const showTranscript = Boolean(transcript) || status === "listening" || status === "error";

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
      activity: (energy) => setLevel(energy),
    });
    session.current = next;
    void next.start();
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
          <span>Transcription preview</span>
          <button type="button" disabled={!transcript} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <button type="button" disabled={!transcript || active} onClick={() => { setSegments(emptyTranscript()); setCopied(false); }}>Clear</button>
        </div>
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

import { useVaultStream } from "./hooks/useVaultStream";
import { useAgentPolling } from "./hooks/useAgentPolling";
import { refreshAgents, refreshTasks } from "./state/agents";
import { useVault, useNoteIds } from "./state/store";
import GraphView from "./views/GraphView";
import DetailPanel from "./views/DetailPanel";
import HandCursor from "./views/HandCursor";
import HandDebug from "./views/HandDebug";
import { cameraPointer, usePointerStore } from "./input";
import { useLocalFolder } from "./knowledge/useLocalFolder";
import VoicePanel from "./views/VoicePanel";

export default function App() {
  useVaultStream();
  useAgentPolling();
  const connected = useVault((s) => s.connected);
  const count = useNoteIds().length;

  // Hide the native cursor only while the hand actually owns the cursor. If the
  // user grabs the mouse (mouse mode), the native cursor returns and takes over.
  const handActive = usePointerStore((s) => s.status === "tracking" && s.mode === "hand");

  return (
    <div className={`app${handActive ? " hand-active" : ""}`}>
      <GraphView />
      <div className="vignette" />

      <header className="head">
        <div className="eyebrow">Marbles</div>
      </header>

      <span className={`status ${connected ? "up" : "down"}`}>
        {connected ? "live" : "offline"} · {count} notes
      </span>
      <button className="agent-refresh" onClick={() => { void refreshAgents(); void refreshTasks(); }}>Refresh agents</button>

      <DetailPanel />
      <VoicePanel />
      <HandCursor />
      <FolderButton />
      <HandDebug />
      <HandDebugToggle />
      <HandPriorityToggle />
      <HandCursorToggle />
    </div>
  );
}

// Prototype of the PWA knowledge path: read a local folder in the browser via
// the File System Access API (no Node server). Hidden where the API is absent
// (Firefox, iOS Safari), which is itself the signal that those surfaces need a
// connector/cloud path instead.
function FolderButton() {
  const { pick, status, error } = useLocalFolder();
  if (status === "unsupported") return null;
  const label =
    status === "loading"
      ? "reading folder..."
      : status === "watching"
        ? "folder: watching"
        : status === "error"
          ? "folder: error"
          : "open folder";
  return (
    <button
      className={`folder-btn${status === "watching" ? " on" : ""}`}
      title={error ?? undefined}
      onClick={pick}
    >
      {label}
    </button>
  );
}

// Camera cursor needs explicit consent (and a camera prompt), so it is opt-in
// behind a toggle rather than auto-started. Both hands are tracked; which one
// drives the cursor is chosen by the sibling control to the left.
function HandCursorToggle() {
  const status = usePointerStore((s) => s.status);
  const error = usePointerStore((s) => s.error);
  const on = status === "tracking" || status === "starting";
  const label =
    status === "starting"
      ? "starting..."
      : status === "tracking"
        ? "hand cursor: on"
        : status === "denied"
          ? "camera blocked"
          : status === "error"
            ? "hand cursor: error"
            : "hand cursor: off";
  return (
    <button
      className={`sq-btn hand-btn${on ? " on" : ""}`}
      title={error ?? label}
      aria-label={label}
      aria-pressed={on}
      onClick={() => (on ? cameraPointer.stop() : cameraPointer.start())}
    >
      {/* Open hand. Built from rounded primitives rather than one long path, so
          it stays crisp at 20px and is trivial to reshape. */}
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden focusable="false">
        <g fill="currentColor">
          <rect x="7.5" y="5" width="2.2" height="8" rx="1.1" />
          <rect x="10.6" y="3.4" width="2.2" height="9.6" rx="1.1" />
          <rect x="13.7" y="4.4" width="2.2" height="8.6" rx="1.1" />
          <rect x="16.8" y="6.2" width="2.2" height="6.8" rx="1.1" />
          <rect x="4.6" y="9" width="2.2" height="6" rx="1.1" transform="rotate(-32 5.7 12)" />
          <rect x="6.9" y="11" width="12.1" height="9" rx="4" />
        </g>
      </svg>
    </button>
  );
}

// Landmark overlay toggle. There is nothing to inspect with the camera off, so
// it stays hidden until tracking starts and then fades in. Kept mounted rather
// than conditionally rendered, so it can actually animate instead of popping.
function HandDebugToggle() {
  const on = usePointerStore((s) => s.debug);
  const tracking = usePointerStore((s) => s.status === "tracking");
  const toggle = usePointerStore((s) => s.toggleDebug);
  return (
    <button
      className={`sq-btn hand-debug-btn${tracking ? " avail" : ""}${on ? " on" : ""}`}
      tabIndex={tracking ? undefined : -1}
      aria-hidden={!tracking}
      title={`Hand landmarks: ${on ? "on" : "off"}`}
      aria-label={`Hand landmarks: ${on ? "on" : "off"}`}
      aria-pressed={on}
      onClick={toggle}
    >
      {/* Three joints and their bones: the skeleton, not another hand. */}
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden focusable="false">
        <g stroke="currentColor" strokeWidth="1.4" fill="none">
          <path d="M6 18 L10 9 L15 13 L18 6" />
        </g>
        <g fill="currentColor">
          <circle cx="6" cy="18" r="2" />
          <circle cx="10" cy="9" r="2" />
          <circle cx="15" cy="13" r="2" />
          <circle cx="18" cy="6" r="2" />
        </g>
      </svg>
    </button>
  );
}

// Which hand owns the cursor when both are in frame. Sits immediately left of
// the hand-cursor square and shares its chrome, so the pair reads as one
// control. Stays usable while tracking is off so the choice can be preset.
function HandPriorityToggle() {
  const priority = usePointerStore((s) => s.priority);
  const setPriority = usePointerStore((s) => s.setPriority);
  const on = usePointerStore((s) => s.status === "tracking");
  const next = priority === "R" ? "L" : "R";
  return (
    <button
      className={`sq-btn hand-side-btn${on ? " on" : ""}`}
      title={`Primary hand: ${priority === "R" ? "right" : "left"}. Click for ${next === "R" ? "right" : "left"}.`}
      aria-label={`Primary hand: ${priority === "R" ? "right" : "left"}`}
      onClick={() => setPriority(next)}
    >
      {priority}
    </button>
  );
}

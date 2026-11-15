import { useEffect, useState } from "react";
import { useVaultStream } from "./hooks/useVaultStream";
import { useAgentPolling } from "./hooks/useAgentPolling";
import { useVault } from "./state/store";
import { useAgents } from "./state/agents";
import GraphView from "./views/GraphView";
import DetailPanel from "./views/DetailPanel";
import HandCursor from "./views/HandCursor";
import { cameraPointer, usePointerStore } from "./input";
import VoicePanel from "./views/VoicePanel";
import PresentationStage from "./views/PresentationStage";
import { usePresentations } from "./hooks/usePresentations";
import { usePresentation } from "./state/presentation";
import GestureWidget from "./views/GestureWidget";
import MediaStage from "./views/MediaStage";
import GestureDismiss from "./views/GestureDismiss";
import SlingRingPortal from './views/SlingRingPortal';
import { attentionTracker } from "./attention/AttentionTracker";
import { disableTabCapture, enableTabCapture } from "./state/screen";
import VideoWindow from "./views/VideoWindow";
import { useDisplay } from "./state/display";
import { REDUCED_MOTION, useHud } from "./state/hud";

const BOOT_MS = 2300;

function Clock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return <time dateTime={time.toISOString()}>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>;
}

export default function App() {
  useVaultStream();
  useAgentPolling();
  usePresentations();
  const showing = useDisplay(s => !!s.display);
  const presenting = usePresentation(s => s.phase !== 'idle') || showing;
  const connected = useVault(s => s.connected);
  const agents = useAgents(s => s.agents);
  const count = agents.filter(a => a.codingAgent).length;
  const handActive = usePointerStore(s => s.status === 'tracking' && s.mode === 'hand');
  const voice = useHud(s => s.voice);
  const speaking = useHud(s => s.speaking);
  // The projector warms up once per visit: a ring of light, then the room.
  const [booting, setBooting] = useState(!REDUCED_MOTION);
  useEffect(() => {
    if (!booting) return;
    const timer = window.setTimeout(() => setBooting(false), BOOT_MS);
    return () => window.clearTimeout(timer);
  }, [booting]);

  return <div className={`app canvas-app voice-${voice}${speaking ? ' voice-speaking' : ''}${presenting ? ' has-presentation' : ''}${handActive ? ' hand-active' : ''}${booting ? ' booting' : ''}`}>
    <a className="skip-link" href="#team-canvas">Skip to team canvas</a>
    <div className="hud-backdrop" aria-hidden="true"><i /></div>
    <main id="team-canvas" tabIndex={-1} aria-label="Your agent canvas"><GraphView /></main>
    <div className="hud-vignette" aria-hidden="true" />
    <div className="hud-frame" aria-hidden="true"><i className="tl" /><i className="tr" /><i className="bl" /><i className="br" /></div>
    <header className="canvas-header">
      <div className="canvas-brand">
        <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
          <circle className="brand-ring" cx="20" cy="20" r="17" />
          <circle cx="20" cy="20" r="11" />
          <circle className="brand-core" cx="20" cy="20" r="4.5" />
        </svg>
        marbles
      </div>
      <span className={`canvas-connection${connected ? ' connected' : ''}`} role="status"><span aria-hidden="true" />{connected ? 'Online' : 'Reconnecting'}<Clock /></span>
    </header>
    {!count && !booting && <p className="canvas-empty">Looking for Codex, Claude Code or Cursor on this computer.</p>}
    <VoicePanel onActivate={() => { void enableTabCapture(); void cameraPointer.start(); void attentionTracker.start(); }} onDeactivate={() => { cameraPointer.stop(); attentionTracker.stop(); disableTabCapture(); }} />
    <DetailPanel disabled={presenting} />
    <PresentationStage />
    <MediaStage />
    <VideoWindow />
    <GestureWidget />
    <HandCursor />
    <GestureDismiss />
    <SlingRingPortal />
    {booting && <div className="boot" aria-hidden="true">
      <svg viewBox="0 0 200 200">
        <circle className="boot-ring a" cx="100" cy="100" r="62" pathLength="100" />
        <circle className="boot-ring b" cx="100" cy="100" r="48" pathLength="100" />
        <circle className="boot-ring c" cx="100" cy="100" r="78" pathLength="100" />
        <circle className="boot-core" cx="100" cy="100" r="9" />
      </svg>
    </div>}
  </div>;
}

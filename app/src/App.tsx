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

export default function App() {
  useVaultStream();
  useAgentPolling();
  usePresentations();
  const presenting = usePresentation(s => s.phase !== 'idle');
  const connected = useVault(s => s.connected);
  const agents = useAgents(s => s.agents);
  const tasks = useAgents(s => s.tasks);
  const swarms = useAgents(s => s.swarms);
  const count = agents.filter(a => a.codingAgent).length;
  const working = new Set([...tasks.filter(t => t.status === 'running').map(t => t.agentId), ...swarms.filter(s => ['running', 'evaluating'].includes(s.status)).flatMap(s => s.agents)]).size;
  const handActive = usePointerStore(s => s.status === 'tracking' && s.mode === 'hand');

  return <div className={`app canvas-app${presenting ? ' has-presentation' : ''}${handActive ? ' hand-active' : ''}`}>
    <a className="skip-link" href="#team-canvas">Skip to team canvas</a>
    <main id="team-canvas" tabIndex={-1} aria-label="Your agent canvas"><GraphView /></main>
    <header className="canvas-header">
      <div className="canvas-brand"><span className="brand-mark" aria-hidden="true">◈</span>marbles<span className="brand-caption">VOICE + GESTURE</span></div>
      <span className={`canvas-connection${connected ? ' connected' : ''}`} role="status"><span aria-hidden="true" />{connected ? 'Connected' : 'Reconnecting…'}</span>
    </header>
    <section className="canvas-intro" aria-label="Team overview"><h1>Your team. At your command.</h1><p>{count ? `${count} teammates · ${working ? `${working} working` : 'Standing by'}` : 'Looking for your teammates…'}</p></section>
    {!count && <p className="canvas-empty">Your agents will appear here when the local server finds Codex, Claude Code or Cursor.</p>}
    <VoicePanel onActivate={() => { void cameraPointer.start(); }} onDeactivate={() => cameraPointer.stop()} />
    <p className="gesture-guide">Say what you need. Point and pinch to check in with your team.</p>
    <DetailPanel disabled={presenting} />
    <PresentationStage />
    <HandCursor />
  </div>;
}

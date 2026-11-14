import express from "express";
import { detectAgents } from "../agents/detectAgents.mjs";
import { TaskService, resolveArtifact } from "../agents/taskService.mjs";
import { agentLog } from "../agents/logs.mjs";
import { AgentRegistry } from "../agents/AgentRegistry.mjs";
import { spawn } from "node:child_process";
import { VoiceCommands } from "../agents/voiceCommands.mjs";
import { taskCapability } from "../agents/taskService.mjs";
import { localVoiceOrigin } from "./voice.mjs";
import { speechHandler } from "./speech.mjs";
import { SwarmService } from "../swarm/SwarmService.mjs";
import { randomUUID } from 'node:crypto';
import { routeTask } from '../scenarios/router.mjs';
import { runScenarios } from '../scenarios/runScenario.mjs';
import { scenarios, scenarioById } from '../scenarios/scenarios.mjs';

// Transport layer: exposes the VaultService over HTTP. A snapshot endpoint and
// an SSE stream that subscribes to the service's change events.
export function createApp(service, { agentDetector = detectAgents, agentRegistry = new AgentRegistry({ detector: agentDetector }), taskService, swarmService, voiceCommands } = {}) {
  taskService ??= new TaskService({ agentDetector: () => agentRegistry.snapshot() });
  swarmService ??= new SwarmService({ agentDetector: () => agentRegistry.snapshot(), root: taskService.root, taskService });
  taskService.externalBusy = id => swarmService.isBusy(id);
  const readLog = id => {
    if (id !== 'cursor') return agentLog(id);
    const task = taskService.snapshot().find(task => task.agentId === id);
    const runs = swarmService.snapshot().flatMap(swarm => swarm.runs ?? []).filter(run => run.agentId === id).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const latest = [task && { at: task.createdAt, stdout: task.stdout }, runs[0] && { at: runs[0].startedAt, stdout: runs[0].stdout }].filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return agentLog(id, undefined, latest?.stdout);
  };
  voiceCommands ??= new VoiceCommands({ taskService, swarmService, agentRegistry, readLog });
  const app = express();
  const scenarioRuns = new Map();
  const publicAgent = agent => ({ ...agent, reason: taskCapability(agent) ?? agent.reason, status: !agent.available || taskCapability(agent) ? 'unavailable' : taskService.isBusy(agent.id) ? 'running' : 'idle' });
  app.use(express.json({ limit: "32kb" }));
  app.post('/api/voice/speech', speechHandler());

  app.get("/api/vault", (_req, res) => res.json(service.snapshot()));
  app.get("/api/agents", (_req, res) => res.json(agentRegistry.snapshot().map(publicAgent)));
  app.get("/api/agents/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsubscribe = agentRegistry.onChange(({ type, agent, id }) => send(type, agent ? publicAgent(agent) : { id }));
    send("snapshot", agentRegistry.snapshot().map(publicAgent));
    req.on("close", unsubscribe);
  });
  app.get("/api/tasks", (_req, res) => res.json(taskService.snapshot()));
  app.get('/api/swarm/tasks', (_req, res) => res.json(swarmService.snapshot()));
  app.post('/api/route', async (req,res) => {
    try { res.json(await routeTask({goal:req.body?.goal})); } catch(e) { res.status(400).json({error:e.message}); }
  });
  app.post('/api/tasks/auto', async (req,res) => {
    try {
      const routing=await routeTask({goal:req.body?.goal});
      if (routing.mode==='solo') res.status(202).json({routing,task:await taskService.startIdle(req.body.goal,{routing})});
      else res.status(202).json({routing,swarm:await swarmService.start({goal:req.body.goal,mode:'swarm',routing})});
    } catch(e) { res.status(e.code==='AGENT_BUSY'?409:e.code==='NO_AGENTS'?503:400).json({error:e.message}); }
  });
  app.post('/api/scenarios/run', (req,res) => {
    const {scenarios: ids,agents,dryRun}=req.body??{};
    if (ids!==undefined && (!Array.isArray(ids)||!ids.length||ids.some(id=>!scenarioById(id)))) return res.status(400).json({error:'Unknown or empty scenario selection'});
    if (typeof dryRun!=='boolean' && dryRun!==undefined) return res.status(400).json({error:'dryRun must be boolean'});
    const id=randomUUID(), state={id,status:'running',completed:0,total:(ids?.length??scenarios.length)*2}; scenarioRuns.set(id,state);
    void runScenarios({selected:ids,agents,dryRun:dryRun??false,root:taskService.root,onProgress:p=>Object.assign(state,p)}).then(result=>Object.assign(state,{status:'completed',completed:state.total,result})).catch(error=>Object.assign(state,{status:'failed',error:error.message}));
    res.status(202).json({id});
  });
  app.get('/api/scenarios/runs/:id',(req,res)=>{ const run=scenarioRuns.get(req.params.id); if (!run) return res.status(404).json({error:'Run not found'}); res.json(run); });
  app.post('/api/swarm/tasks', async (req, res) => {
    try { const {goal,agents,mode,maxTurns,concurrency,size}=req.body??{}; res.status(202).json({ swarm: await swarmService.start({goal,agents,mode,maxTurns,concurrency,size}) }); }
    catch (e) { res.status(e.code === 'AGENT_BUSY' ? 409 : e.code === 'NO_AGENTS' ? 503 : 400).json({ error: e.message }); }
  });
  app.get('/api/swarm/stats', (_req, res) => res.json(swarmService.statsSnapshot()));
  app.get('/api/swarm/tasks/:id', async (req, res) => {
    const swarm = swarmService.detail ? await swarmService.detail(req.params.id) : swarmService.get(req.params.id);
    if (!swarm) return res.status(404).json({ error: 'Swarm not found' });
    res.json(swarm);
  });
  app.post('/api/swarm/tasks/:id/cancel', (req, res) => {
    const swarm = swarmService.cancel(req.params.id);
    if (!swarm) return res.status(404).json({ error: 'Swarm not found' });
    res.json({ swarm });
  });
  app.post("/api/voice/tasks", async (req, res) => {
    if (!localVoiceOrigin(req.headers.origin)) return res.status(403).json({ error: 'Voice commands require a local app origin.' });
    try {
      const result = await voiceCommands.dispatch(req.body);
      res.status(['assigned', 'swarm'].includes(result.state) ? 202 : 200).json(result);
    } catch (error) {
      const status = error.code === 'AGENT_BUSY' ? 409 : error.code === 'NO_AGENTS' ? 503 : 400;
      res.status(status).json({ error: error.name === 'TimeoutError' ? 'Task interpretation timed out. Please retry.' : error.message });
    }
  });
  app.post('/api/assistant/ask', async (req, res) => {
    if (!localVoiceOrigin(req.headers.origin)) return res.status(403).json({ error: 'Assistant questions require a local app origin.' });
    const question = req.body?.question;
    if (typeof question !== 'string' || !question.trim() || question.length > 6000) return res.status(400).json({ error: 'Supply a question under 6,000 characters.' });
    try { res.json(await voiceCommands.dispatch({ transcript: question, requestId: randomUUID() })); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post("/api/agents/:id/tasks", async (req, res) => {
    try { res.status(202).json(await taskService.start(req.params.id, req.body?.prompt)); }
    catch (error) { res.status(error.code === 'AGENT_BUSY' ? 409 : error.message === "Agent not found" ? 404 : 400).json({ error: error.message }); }
  });
  app.get("/api/agents/:id/log", async (req, res) => {
    try {
      const agent = agentRegistry.snapshot().find(a => a.id === req.params.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(await readLog(agent.id));
    } catch { res.status(500).json({ error: "Could not read agent log" }); }
  });
  app.get("/api/artifacts/file", async (req, res) => {
    try {
      const file = await resolveArtifact(taskService.root, req.query.path);
      res.sendFile(file);
    } catch { res.status(400).json({ error: "Invalid artifact path" }); }
  });
  app.post("/api/artifacts/open", async (req, res) => {
    try {
      const file = await resolveArtifact(taskService.root, req.body?.path);
      const child = spawn("open", [file], { shell: false, stdio: "ignore" });
      child.on("error", () => {});
      res.json({ ok: true });
    } catch { res.status(400).json({ error: "Invalid artifact path" }); }
  });

  app.get("/api/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(service.snapshot())}\n\n`);

    const unsubscribe = service.onChange((evt) => {
      const event = evt.type === "update" ? "update" : "remove";
      const data = evt.type === "update" ? evt.note : { id: evt.id };
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    req.on("close", unsubscribe);
  });

  return app;
}

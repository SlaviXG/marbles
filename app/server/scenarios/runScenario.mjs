import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SwarmService } from '../swarm/SwarmService.mjs';
import { workspaceRoot } from '../agents/taskService.mjs';
import { detectAgents } from '../agents/detectAgents.mjs';
import { scenarios, scenarioById, writeCannedOutput } from './scenarios.mjs';
import { routeTask } from './router.mjs';

const safeStamp = () => new Date().toISOString().replace(/[:.]/g,'-');
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const PROGRESS_INTERVAL_MS = 15_000;
export async function waitFor(swarm, service, deadline, progress) {
  let nextProgress = Date.now() + PROGRESS_INTERVAL_MS;
  while (!swarm.persisted) {
    if (swarm.timedOut || Date.now() >= deadline) {
      service.cancel(swarm.id);
      return false;
    }
    if (Date.now() >= nextProgress) {
      progress(swarm.status);
      nextProgress = Date.now() + PROGRESS_INTERVAL_MS;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  if (swarm.timedOut || Date.now() >= deadline) {
    service.cancel(swarm.id);
    return false;
  }
  return true;
}
export function fakeScenarioSpawn(scenario, mode) {
  return (_command, _args, options) => {
    const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.kill=()=>child.emit('close',1);
    queueMicrotask(async () => {
      try {
        const partial = mode==='best-of-n' && (scenario.id==='split-info-roster' || ['doc-diff','data-report','email-triage'].includes(scenario.id));
        await writeCannedOutput(path.join(options.cwd,'shared'), scenario, partial);
        child.stdout.emit('data',`Completed ${scenario.id}`); child.emit('close',0);
      } catch (error) { child.stderr.emit('data',String(error)); child.emit('close',1); }
    });
    return child;
  };
}
export async function runScenarios({ selected = scenarios.map(s=>s.id), agents = ['codex','claude'], dryRun = false, keep = false, root = workspaceRoot(), resultsDir = path.resolve('scenario-results'), timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {}, detector = detectAgents, serviceFactory = options => new SwarmService(options) } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.some(id=>!scenarioById(id))) throw new Error('Unknown or empty scenario selection');
  if (!Array.isArray(agents) || !agents.length || agents.length>4 || new Set(agents).size!==agents.length || agents.some(id=>!['codex','claude','cursor'].includes(id))) throw new Error('Choose 1 to 4 distinct supported agents');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2) throw new Error('timeoutMs must be at least 2 milliseconds');
  const runId=`${safeStamp()}-${randomUUID().slice(0,8)}`;
  const runRoot=path.join(root,'scenarios',runId);
  const detected=dryRun ? agents.map(id=>({id,name:id,kind:'cli',path:id,available:true})) : await detector();
  const active=detected.filter(a=>agents.includes(a.id)&&a.available&&a.kind==='cli');
  if (active.length!==agents.length) throw new Error('One or more selected CLI agents are unavailable');
  const rows=[];
  await fs.mkdir(runRoot,{recursive:true});
  try {
    for (const id of selected) {
      const scenario=scenarioById(id), routing=await routeTask({goal:scenario.goal,scenario});
      for (const mode of ['best-of-n','swarm']) {
        const progress = status => onProgress({runId,scenario:id,mode,status,completed:rows.length,total:selected.length*2});
        progress('running');
        // SwarmService owns the agent budget; the rest of the mode budget is for evaluation and persistence.
        const service=serviceFactory({root:path.join(runRoot,mode),agentDetector:async()=>active,spawnProcess:dryRun?fakeScenarioSpawn(scenario,mode):undefined,timeoutMs:Math.floor(timeoutMs*2/3),
          evaluator:async ({soloDir,swarmDir})=>{ const result=await scenario.check(path.join(soloDir??swarmDir,'shared')); return {...result,contributions:{},lesson:'',rationale:'Deterministic scenario rubric'}; }});
        const start=Date.now();
        let swarm, completed = false, error;
        try {
          swarm=await service.start({goal:scenario.goal,agents,mode,maxTurns:agents.length,fixtures:scenario.fixtures,privateFixtures:scenario.privateFixtures, routing,workspaceRoot:path.join(runRoot,mode)});
          completed=await waitFor(swarm,service,start+timeoutMs,progress) && swarm.status==='completed';
          if (!completed) error=swarm.timedOut || Date.now()>=start+timeoutMs ? 'Scenario timed out' : swarm.error??swarm.status;
        } catch (cause) {
          if (swarm) service.cancel(swarm.id);
          error=cause.message;
        }
        const status=completed?'completed':'failed';
        rows.push({scenario:id,mode,agents,status,success:completed?swarm.success:0,reward:completed?swarm.reward:0,tokenProxy:swarm?.tokenProxy??0,runs:swarm?.runs?.length??0,durationSec:Number(((Date.now()-start)/1000).toFixed(3)),routing,checks:completed?swarm.checks??[]:[],...(error?{error}:{})});
        progress(status);
      }
    }
    await fs.mkdir(resultsDir,{recursive:true});
    const jsonl=path.join(resultsDir,`${runId}.jsonl`), markdown=path.join(resultsDir,`${runId}.md`);
    const table=['| Scenario | Mode | Status | Agents | Runs | Success | Reward | Token proxy | Routing |','|---|---|---|---:|---:|---:|---:|---:|---|',...rows.map(r=>`| ${r.scenario} | ${r.mode} | ${r.status} | ${r.agents.length} | ${r.runs} | ${r.success.toFixed(2)} | ${r.reward.toFixed(3)} | ${r.tokenProxy} | ${r.routing.mode} |`)].join('\n')+'\n';
    await fs.writeFile(jsonl,rows.map(r=>JSON.stringify(r)).join('\n')+'\n'); await fs.writeFile(markdown,`# Scenario run ${runId}\n\n${table}`); await fs.copyFile(markdown,path.join(resultsDir,'latest.md'));
    return {runId,rows,jsonl,markdown,table};
  } finally { if (!keep) await fs.rm(runRoot,{recursive:true,force:true}); }
}

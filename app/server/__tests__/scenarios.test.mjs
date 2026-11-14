import { describe,it,expect,vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scenarios, scenarioById, writeCannedOutput } from '../scenarios/scenarios.mjs';
import { routeTask } from '../scenarios/router.mjs';
import { runScenarios, waitFor } from '../scenarios/runScenario.mjs';
import { createApp } from '../transport/createApp.mjs';

async function temporary(fn) { const dir=await mkdtemp(path.join(os.tmpdir(),'marbles-scenario-')); try { return await fn(dir); } finally { await rm(dir,{recursive:true,force:true}); } }
const route=(app,method,url)=>app._router.stack.find(layer=>layer.route?.path===url&&layer.route.methods[method]).route.stack[0].handle;
const response=()=>({statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}});

describe('office scenarios',()=>{
  it('waits past 30 seconds, reports progress, and cancels at the deadline',async()=>{
    vi.useFakeTimers();
    try {
      const service={cancel:vi.fn()};
      const progress=vi.fn();
      const swarm={id:'slow',status:'running',persisted:false};
      const waiting=waitFor(swarm,service,Date.now()+45_000,progress);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(service.cancel).not.toHaveBeenCalled();
      expect(progress).toHaveBeenCalledWith('running');
      swarm.persisted=true; swarm.status='completed';
      await vi.advanceTimersByTimeAsync(100);
      expect(await waiting).toBe(true);
      const stuck={id:'stuck',status:'running',persisted:false};
      const timedOut=waitFor(stuck,service,Date.now()+30_000,progress);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await timedOut).toBe(false);
      expect(service.cancel).toHaveBeenCalledWith('stuck');
    } finally { vi.useRealTimers(); }
  });
  it('writes failed modes and subsequent results, then cleans the workspace',async()=>temporary(async dir=>{
    const cancel=vi.fn();
    const budgets=[];
    const statuses=[];
    const result=await runScenarios({selected:['meeting-summary'],agents:['codex'],root:path.join(dir,'workspace'),resultsDir:path.join(dir,'results'),timeoutMs:90_000,
      detector:async()=>[{id:'codex',name:'Codex',kind:'cli',path:'codex',available:true}],
      onProgress:event=>statuses.push(event.status),
      serviceFactory:options=>{
        budgets.push(options.timeoutMs);
        const mode=budgets.length===1?'best-of-n':'swarm';
        return {cancel,start:async()=>({id:mode,status:mode==='best-of-n'?'running':'completed',timedOut:mode==='best-of-n',persisted:true,runs:[],success:1,reward:0.8,tokenProxy:2,checks:[]})};
      }});
    expect(budgets).toEqual([60_000,60_000]);
    expect(cancel).toHaveBeenCalledWith('best-of-n');
    expect(result.rows.map(row=>[row.status,row.success])).toEqual([['failed',0],['completed',1]]);
    expect(statuses).toEqual(['running','failed','running','completed']);
    expect((await readFile(result.jsonl,'utf8')).trim().split('\n')).toHaveLength(2);
    expect(await readdir(path.join(dir,'workspace','scenarios'))).toEqual([]);
  }));
  it('records an elapsed mode deadline and continues to the next mode',async()=>temporary(async dir=>{
    vi.useFakeTimers();
    try {
      const cancel=vi.fn();
      let started;
      const firstStarted=new Promise(resolve=>{started=resolve;});
      let calls=0;
      const pending=runScenarios({selected:['meeting-summary'],agents:['codex'],root:path.join(dir,'workspace'),resultsDir:path.join(dir,'results'),timeoutMs:20,
        detector:async()=>[{id:'codex',name:'Codex',kind:'cli',path:'codex',available:true}],
        onProgress:event=>{if(event.mode==='best-of-n'&&event.status==='running') started();},
        serviceFactory:()=>({cancel,start:async()=>({id:`mode-${++calls}`,status:calls===1?'running':'completed',persisted:calls!==1,runs:[],success:1,reward:1,tokenProxy:0})})});
      await firstStarted;
      await vi.advanceTimersByTimeAsync(20);
      const result=await pending;
      expect(cancel).toHaveBeenCalledWith('mode-1');
      expect(result.rows.map(row=>[row.status,row.success])).toEqual([['failed',0],['completed',1]]);
      expect(result.rows[0].error).toBe('Scenario timed out');
      expect(await readdir(path.join(dir,'workspace','scenarios'))).toEqual([]);
    } finally { vi.useRealTimers(); }
  }));
  it('all eight known good outputs pass and empty outputs fail',async()=>temporary(async dir=>{
    expect(scenarios).toHaveLength(8);
    for(const scenario of scenarios){const good=path.join(dir,scenario.id,'good'),bad=path.join(dir,scenario.id,'bad'); await mkdir(bad,{recursive:true}); await writeCannedOutput(good,scenario); expect((await scenario.check(good)).score,scenario.id).toBe(1); expect((await scenario.check(bad)).score,scenario.id).toBeLessThan(1);}
  }));
  it('routes focused summaries solo and split inputs or broad logs swarm with reasons',async()=>{
    const summary=await routeTask({goal:'Summarize this meeting.'}); expect(summary.mode).toBe('solo'); expect(summary.reason).toMatch(/focused/i);
    const roster=await routeTask({goal:scenarioById('split-info-roster').goal,scenario:scenarioById('split-info-roster')}); expect(roster.mode).toBe('swarm'); expect(roster.reason).toMatch(/pooling information/i);
    const logs=await routeTask({goal:scenarioById('split-search-bug').goal,scenario:scenarioById('split-search-bug')}); expect(logs.mode).toBe('swarm'); expect(logs.reason).toMatch(/search/i);
  });
  it.each([
    'Each of us holds part of the team roster; combine them into roster.csv',
    'Each agent has a portion of the roster.',
    'Each of us gets a separate roster entry.',
    'Use part of the records held by each teammate.',
    'Read your private file and create roster.csv.',
    'Read your private input and create roster.csv.',
    'Read your private notes and create roster.csv.',
    'Merge the roster entries into roster.csv.',
    'Aggregate the roster entries into roster.csv.',
    'Pool our roster entries into roster.csv.',
    'Pool the roster entries into roster.csv.',
  ])('routes split information from free text: %s',async goal=>{
    const result=await routeTask({goal});
    expect(result.mode).toBe('swarm');
    expect(result.signals.privateInputs).toBe(true);
    expect(result.reason).toBe('Inputs are split across agents; pooling information needs a team.');
  });
  it.each([
    'Search the logs for the failure.',
    'Find the relevant files.',
    'Hunt through the sources for a matching fact.',
    'Investigate the documents and repos for the discrepancy.',
  ])('routes broad free-text searches: %s',async goal=>{
    const result=await routeTask({goal});
    expect(result.mode).toBe('swarm');
    expect(result.signals.searchBreadth).toBe(true);
  });
  it.each([
    'Create x.csv and y.md.',
    'Write a report, a checklist, and an agenda.',
    'Deliver 1. a report 2. a chart.',
  ])('routes multiple deliverables: %s',async goal=>{
    const result=await routeTask({goal});
    expect(result.mode).toBe('swarm');
    expect(result.signals.multipleDeliverables).toBe(true);
  });
  it('keeps a single-file summary solo',async()=>{
    const result=await routeTask({goal:'Summarise transcript.txt into a short summary'});
    expect(result.mode).toBe('solo');
    expect(result.signals).toMatchObject({privateInputs:false,searchBreadth:false,multipleDeliverables:false});
    expect((await routeTask({goal:scenarioById('meeting-summary').goal})).mode).toBe('solo');
    expect((await routeTask({goal:'Write x.csv from input/a.txt and input/b.txt'})).mode).toBe('solo');
    expect((await routeTask({goal:'Write x.csv and update x.csv'})).mode).toBe('solo');
  });
  it('auto endpoint chooses the matching service and records routing',async()=>{
    const startIdle=vi.fn(async(_goal,metadata)=>({id:'t',routing:metadata.routing})); const start=vi.fn(async args=>({id:'s',routing:args.routing}));
    const app=createApp({snapshot:()=>({notes:[]}),onChange:()=>()=>{}},{agentRegistry:{snapshot:()=>[]},taskService:{root:'/tmp',startIdle,snapshot:()=>[],isBusy:()=>false},swarmService:{start,snapshot:()=>[],isBusy:()=>false}});
    let res=response(); await route(app,'post','/api/tasks/auto')({body:{goal:'Summarize this note.'}},res); expect(res.body.routing.mode).toBe('solo'); expect(startIdle).toHaveBeenCalledOnce();
    res=response(); await route(app,'post','/api/tasks/auto')({body:{goal:'Search all six log files and identify the root cause.'}},res); expect(res.body.routing.mode).toBe('swarm'); expect(start).toHaveBeenCalledOnce();
  });
  it('dry run writes matched budgets and cleans workspaces',async()=>temporary(async dir=>{
    const result=await runScenarios({selected:['meeting-summary','split-info-roster'],agents:['codex','claude'],dryRun:true,root:path.join(dir,'workspace'),resultsDir:path.join(dir,'results')});
    expect(result.rows).toHaveLength(4); expect(result.rows.every(r=>r.runs===2)).toBe(true);
    expect(result.rows.find(r=>r.scenario==='split-info-roster'&&r.mode==='swarm').success).toBe(1);
    expect(result.rows.find(r=>r.scenario==='split-info-roster'&&r.mode==='best-of-n').success).toBeLessThan(1);
    expect((await readFile(result.jsonl,'utf8')).trim().split('\n')).toHaveLength(4);
    expect(await readFile(path.join(dir,'results','latest.md'),'utf8')).toContain('| split-info-roster |');
    expect(await readdir(path.join(dir,'workspace','scenarios'))).toEqual([]);
  }));
  it('seeds private files per agent in swarm and solo workspaces',async()=>temporary(async dir=>{
    const result=await runScenarios({selected:['split-info-roster'],agents:['codex','claude'],dryRun:true,keep:true,root:path.join(dir,'workspace'),resultsDir:path.join(dir,'results')});
    const root=path.join(dir,'workspace','scenarios',result.runId);
    const swarmId=(await readdir(path.join(root,'swarm','swarms')))[0]; const soloId=(await readdir(path.join(root,'best-of-n','swarms')))[0];
    expect(await readFile(path.join(root,'swarm','swarms',swarmId,'private','codex','input','private_0.txt'),'utf8')).toContain('Ada');
    expect(await readFile(path.join(root,'swarm','swarms',swarmId,'private','claude','input','private_1.txt'),'utf8')).toContain('Cara');
    expect(await readdir(path.join(root,'best-of-n','swarms',soloId,'solo','codex','input'))).toEqual(['private_0.txt']);
    expect(await readdir(path.join(root,'best-of-n','swarms',soloId,'solo','claude','input'))).toEqual(['private_1.txt']);
  }));
});

import { promises as fs } from 'node:fs';
import path from 'node:path';

const fixture = (name, content) => ({ path: `input/${name}`, content });
const read = async (dir, name) => fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
const rubric = tests => ({ score: tests.filter(c => c.pass).length / tests.length, checks: tests });
const check = (name, pass, detail = '') => ({ name, pass: Boolean(pass), detail });
const words = text => text.trim().split(/\s+/).filter(Boolean).length;
const rows = text => text.trim().split(/\r?\n/).filter(Boolean).map(line => line.split(',').map(v => v.trim()));

const transcript = `Meeting: Phoenix launch, 2026-11-12\nAttendees: Ada, Ben, Cara.\nDecision: launch the beta on 2026-12-03.\nDecision: use the existing support queue.\nAction: Ada will prepare the release notes by 2026-11-20.\nAction: Ben will test the signup flow by 2026-11-22.\nAction: Cara will brief support by 2026-11-25.\nOpen question: can legal approve the privacy copy?\n`;
const receipts = [
  ['2026-10-01','Rail','travel',42,'GBP'], ['2026-10-02','Cafe','meals',18,'EUR'],
  ['2026-10-03','Hotel','lodging',135,'GBP'], ['2026-10-04','Metro','travel',12,'EUR'],
  ['2026-10-05','Lunch','meals',24,'GBP'], ['2026-10-06','Taxi','travel',30,'EUR'],
  ['2026-10-07','Stationery','supplies',16,'GBP'], ['2026-10-08','Dinner','meals',40,'EUR'],
];
const gbp = row => row[4] === 'EUR' ? row[3] * 0.85 : row[3];
const sales = Array.from({length:12}, (_, m) => Array.from({length:3}, (_, r) => ({month:`2026-${String(m+1).padStart(2,'0')}`, region:['North','South','West'][r], amount:100 + m*10 + r*20}))).flat();
const totals = Object.fromEntries(['North','South','West'].map(region => [region, sales.filter(x => x.region === region).reduce((n,x) => n+x.amount,0)]));
const changes = ['approval','30 days','manager','£500','quarterly','encrypted'];
const roster = [
  [{name:'Ada',role:'Design',days:'Mon Wed Fri'},{name:'Ben',role:'Engineering',days:'Tue Wed Fri'}],
  [{name:'Cara',role:'Sales',days:'Wed Thu Fri'},{name:'Dev',role:'Operations',days:'Mon Wed Thu'}],
];
const logs = ['scheduler.log','mail.log','auth.log','sync.log','storage.log','api.log'];
const inbox = Array.from({length:12},(_,i)=>`${i+1}. ${['Client contract expires today','Production outage: customers cannot sign in','Payroll approval due by 5pm','Weekly newsletter','Team lunch','Sales digest','Conference invite','Product update','Vendor brochure','Survey request','Routine receipt','Old meeting notes'][i]}`).join('\n');

export const scenarios = [
  { id:'meeting-summary', title:'Meeting summary', goal:'Summarize input/transcript.txt in shared/summary.md with Decisions, Action items with owners and dates, and Open questions.', fixtures:[fixture('transcript.txt',transcript)], expectedOutputs:['shared/summary.md'],
    async check(dir) { const s=await read(dir,'summary.md'); return rubric([check('sections', ['Decisions','Action items','Open questions'].every(x=>new RegExp(x,'i').test(s))),check('owners', ['Ada','Ben','Cara'].every(x=>s.includes(x))),check('word limit',words(s)>0 && words(s)<=300),check('dates',['2026-11-20','2026-11-22','2026-11-25'].every(x=>s.includes(x)))]); },
    good: '# Decisions\n- Launch beta 2026-12-03; use existing support queue.\n# Action items\n- Ada: release notes by 2026-11-20.\n- Ben: signup test by 2026-11-22.\n- Cara: support briefing by 2026-11-25.\n# Open questions\n- Can legal approve privacy copy?\n' },
  { id:'expense-report', title:'Expense report', goal:'Convert input/receipts.txt into shared/expenses.csv with date,vendor,category,amount_gbp and a total row.', fixtures:[fixture('receipts.txt',`Fixed rate: 1 EUR = 0.85 GBP\n${receipts.map(r=>r.join(' | ')).join('\n')}\n`)], expectedOutputs:['shared/expenses.csv'],
    async check(dir) { const data=rows(await read(dir,'expenses.csv')); const expected=receipts.reduce((n,r)=>n+gbp(r),0); return rubric([check('columns',data[0]?.join(',')==='date,vendor,category,amount_gbp'),check('row count',data.length===10),check('vendors',receipts.every(r=>data.some(d=>d[1]===r[1]))),check('total',Math.abs(Number(data.at(-1)?.[3])-expected)<=0.01)]); },
    good:`date,vendor,category,amount_gbp\n${receipts.map(r=>`${r[0]},${r[1]},${r[2]},${gbp(r).toFixed(2)}`).join('\n')}\nTOTAL,,,${receipts.reduce((n,r)=>n+gbp(r),0).toFixed(2)}\n` },
  { id:'data-report', title:'Sales data report', goal:'Analyze input/sales.csv and write shared/report.md with regional totals, best month, and three insights.', fixtures:[fixture('sales.csv',`month,region,amount_gbp\n${sales.map(x=>`${x.month},${x.region},${x.amount}`).join('\n')}\n`)], expectedOutputs:['shared/report.md'],
    async check(dir) { const s=await read(dir,'report.md'); return rubric([check('region totals',Object.entries(totals).every(([k,v])=>s.includes(k)&&s.includes(String(v)))),check('best month',s.includes('2026-12')),check('three insights',(s.match(/^- /gm)||[]).length>=3),check('one page',words(s)>0&&words(s)<500)]); },
    good:`# Sales report\n| Region | Total GBP |\n|---|---:|\n${Object.entries(totals).map(([k,v])=>`| ${k} | ${v} |`).join('\n')}\n\nBest month: 2026-12.\n- Sales rose each month.\n- West led regional totals.\n- December was strongest.\n` },
  { id:'doc-diff', title:'Policy comparison', goal:'Compare input/policy_v1.md and input/policy_v2.md; list six changes in shared/differences.md.', fixtures:[fixture('policy_v1.md','# Travel policy\nNo approval required. Retain receipts 14 days. Staff book travel. Hotel cap £300. Review annually. Files may be stored unencrypted.\n'),fixture('policy_v2.md','# Travel policy\nManager approval required. Retain receipts 30 days. Manager books travel. Hotel cap £500. Review quarterly. Files must be encrypted.\n')], expectedOutputs:['shared/differences.md'],
    async check(dir) { const s=(await read(dir,'differences.md')).toLowerCase(); return rubric(changes.map(x=>check(x,s.includes(x.toLowerCase())))); },good:`# Changes\n${changes.map(x=>`- ${x} changed in v2.`).join('\n')}\n` },
  { id:'offsite-agenda', title:'Offsite agenda', goal:'Plan a two-day agenda in shared/agenda.md using input/constraints.txt; include ordered times, budget and dietary needs.', fixtures:[fixture('constraints.txt','Dates: 2026-12-10 and 2026-12-11. People: 14. Budget: £2800 total. Dietary: 2 vegan, 1 gluten-free. Two days, 09:00–17:00. Include planning, team activity and breaks.\n')], expectedOutputs:['shared/agenda.md'],
    async check(dir) { const s=await read(dir,'agenda.md'); const days=s.split(/##\s+2026-12-\d\d/).slice(1); const ordered=days.length===2&&days.every(day=>{const times=[...day.matchAll(/\b(\d\d):(\d\d)\b/g)].map(m=>Number(m[1])*60+Number(m[2])); return times.length>=2&&times.every((x,i)=>!i||x>times[i-1]);}); const budget=Number(s.match(/(?:Total budget|Budget total):\s*£?(\d+)/i)?.[1]); return rubric([check('both days',s.includes('2026-12-10')&&s.includes('2026-12-11')),check('ordered times',ordered),check('budget',budget>0&&budget<=2800),check('dietary',/vegan/i.test(s)&&/gluten.free/i.test(s)),check('headcount',s.includes('14'))]); },
    good:'# Offsite for 14 people\n## 2026-12-10\n09:00 Planning\n12:00 Lunch\n14:00 Team activity\n## 2026-12-11\n09:00 Priorities\n12:00 Lunch\n15:00 Commitments\nTotal budget: £2500\nCatering: vegan and gluten-free options.\n' },
  { id:'split-info-roster', title:'Split information roster', goal:'Combine private team roster inputs into shared/roster.csv with name,role,availability and common days when everyone is available. Each agent reads only its private directory and shares findings through the blackboard.', fixtures:[], privateFixtures:Object.fromEntries(roster.map((people,i)=>[i,[{path:`input/private_${i}.txt`,content:people.map(p=>`${p.name} | ${p.role} | ${p.days}`).join('\n')+'\n'}]])), expectedOutputs:['shared/roster.csv'],
    async check(dir) { const s=await read(dir,'roster.csv'); return rubric([check('all people',roster.flat().every(p=>s.includes(p.name))),check('roles',roster.flat().every(p=>s.includes(p.role))),check('common day',/common days?,wed/i.test(s)),check('no false common day',!/common days?,[^\n]*(mon|tue|thu|fri)/i.test(s))]); },
    good:`name,role,availability\n${roster.flat().map(p=>`${p.name},${p.role},${p.days}`).join('\n')}\nCommon days,Wed\n` },
  { id:'split-search-bug', title:'Log search', goal:'Search all six input/*.log files, identify the root-cause error, and write the exact filename and line in shared/finding.md.', fixtures:logs.map((name,i)=>fixture(name, i===4?'2026-11-10 INFO opened store\n2026-11-10 ERROR schema migration failed: missing column account_id\n2026-11-10 WARN retries exhausted\n':`2026-11-10 INFO ${name} started\n2026-11-10 WARN retry scheduled\n2026-11-10 INFO recovered\n`)), expectedOutputs:['shared/finding.md'],
    async check(dir) { const s=await read(dir,'finding.md'); return rubric([check('file',s.includes('storage.log')),check('line',/line\s*2\b/i.test(s)),check('cause',/missing column account_id/i.test(s))]); },good:'Root cause: storage.log line 2 — schema migration failed: missing column account_id.\n' },
  { id:'email-triage', title:'Email triage', goal:'Classify the 12 messages in input/inbox.txt as urgent, reply, or archive with one-line reasons in shared/triage.md.', fixtures:[fixture('inbox.txt',inbox+'\n')], expectedOutputs:['shared/triage.md'],
    async check(dir) { const s=await read(dir,'triage.md'); return rubric([check('all messages',Array.from({length:12},(_,i)=>new RegExp(`(?:^|\\n)${i+1}\\.`).test(s)).every(Boolean)),check('three urgent',Array.from({length:3},(_,i)=>new RegExp(`(?:^|\\n)${i+1}\\.\\s*urgent`,'i').test(s)).every(Boolean)),check('reasons',s.split('\n').filter(x=>/^\d+\./.test(x)).every(x=>x.includes(' — ')))]); },
    good:Array.from({length:12},(_,i)=>`${i+1}. ${i<3?'urgent':i<7?'reply':'archive'} — ${i<3?'time-sensitive issue':i<7?'needs a response':'informational'}.`).join('\n')+'\n' },
];
export const scenarioById = id => scenarios.find(s => s.id === id);
export async function writeFixtures(dir, fixtures) {
  for (const item of fixtures) { if (typeof item.path!=='string'||path.isAbsolute(item.path)||item.path.split(/[\\/]/).includes('..')||typeof item.content!=='string'||item.content.length>=4096) throw new Error('Invalid scenario fixture'); const target=path.join(dir,item.path); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,item.content); }
}
export async function writeCannedOutput(dir, scenario, partial = false) {
  const target=path.join(dir,path.basename(scenario.expectedOutputs[0])); await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,partial ? scenario.good.split('\n').slice(0,Math.max(2,Math.floor(scenario.good.split('\n').length/2))).join('\n')+'\n' : scenario.good);
}

import { scenarioById } from './scenarios.mjs';

export async function routeTask({ goal, scenario } = {}, opts = {}) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 6000) throw new Error('Enter a goal under 6,000 characters');
  const text = goal.trim();
  const selected = typeof scenario === 'string' ? scenarioById(scenario) : scenario;
  const fixtures = selected?.fixtures ?? [];
  const privateInputs = Boolean(selected?.privateFixtures) || /\beach (?:of us|agent) (?:has|holds|gets)\b|\bpart of the\b|\bprivate (?:files?|inputs?|notes)\b|\bsplit[ -]information\b|\bcombine\b|\bmerge\b|\baggregate\b|\bpool (?:our|the)\b/i.test(text);
  const namedFiles = [...new Set((text.match(/\b[\w-]+\.[a-z][a-z0-9]{0,9}\b/gi) ?? []).map(file => file.toLowerCase()))];
  const files = fixtures.length || namedFiles.length;
  const searchBreadth = files >= 5 || /(?:six|6|many|all).*\b(?:logs?|files?)\b/i.test(text) || /\b(?:search|find|hunt|investigate)\b[\s\S]*\b(?:logs|files|sources|documents|repos)\b/i.test(text);
  const sections = (text.match(/\b(?:sections?|deliverables?|report|summary|agenda|table|insights?|action items|open questions)\b/gi) ?? []).length;
  const subparts = (text.match(/\band\b|[,;]|\b\d+\./gi) ?? []).length;
  const deliverableNames = new Set((text.match(/\b(?:reports?|summar(?:y|ies)|agendas?|tables?|checklists?|charts?|presentations?)\b/gi) ?? []).map(name => name.toLowerCase()));
  const outputText = text.match(/\b(?:create|write|produce|generate|save|export|deliver|output)\b[\s\S]*/i)?.[0] ?? '';
  const outputFiles = new Set((outputText.match(/\b(?:input\/)?[\w-]+\.[a-z][a-z0-9]{0,9}\b/gi) ?? []).map(file => file.toLowerCase()).filter(file => !file.startsWith('input/')));
  const multipleDeliverables = outputFiles.size >= 2 || (deliverableNames.size >= 2 && /\band\b|[,;]|\b\d+\./i.test(text)) || (text.match(/\b\d+\.[ \t]+/g) ?? []).length >= 2;
  const signals = { privateInputs, files, searchBreadth, multipleDeliverables, sections, subparts, estimatedSize: text.length };
  const score = (privateInputs ? 5 : 0) + (searchBreadth ? 3 : 0) + (multipleDeliverables ? 3 : 0) + (sections >= 3 ? 1 : 0) + (subparts >= 3 ? 1 : 0) + (text.length > 500 ? 1 : 0);
  let mode = score >= 3 ? 'swarm' : 'solo';
  let reason = privateInputs ? 'Inputs are split across agents; pooling information needs a team.' : searchBreadth ? 'Broad file search benefits from parallel exploration.' : mode === 'swarm' ? 'Several independent parts can be worked in parallel.' : 'A focused deliverable fits one agent.';
  if (opts.useLLM && process.env.OPENAI_API_KEY) {
    const fetcher = opts.fetch ?? fetch;
    try {
      const response = await fetcher('https://api.openai.com/v1/responses', { method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify({model:'gpt-4.1-mini',input:`Choose solo or swarm for this task. Return JSON {"mode":"solo|swarm","reason":"short reason"}. Goal: ${text}`,text:{format:{type:'json_object'}}}) });
      if (response.ok) { const data=await response.json(); const value=JSON.parse(data.output_text ?? data.output?.flatMap(x=>x.content??[]).find(x=>x.type==='output_text')?.text ?? '{}'); if (['solo','swarm'].includes(value.mode) && typeof value.reason==='string') { mode=value.mode; reason=value.reason.slice(0,300); } }
    } catch { /* deterministic heuristic remains available */ }
  }
  return { mode, reason, signals };
}

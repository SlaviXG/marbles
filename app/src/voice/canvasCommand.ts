import type { AgentTask, SwarmTask } from '../core/agentTypes';

// Local viewing commands never launch another agent or open an OS application.
export function canvasCommand(text: string, tasks: AgentTask[], swarms: SwarmTask[] = [], agents: { id: string; name: string }[] = [], nextResult: string | null = null): { select?: string; close?: boolean; reply: string } | null {
  if (/^(?:please\s+)?(?:close|dismiss)\s+(?:(?:this|that|the)?\s*(?:preview|details|file|screen)|it|this|that)(?:\s+please)?[.!?]?$/i.test(text.trim())) {
    return { close: true, reply: 'Back to your team.' };
  }
  // Results wait their turn; this is how to ask for the next one.
  if (nextResult && /^(?:please\s+)?(?:next(?:\s+(?:one|result|file))?|(?:show|open)(?:\s+me)?\s+the\s+next(?:\s+(?:one|result))?|what(?:'s| is)\s+next)[.!?]?$/i.test(text.trim())) {
    return { select: nextResult, reply: 'Next result.' };
  }
  const request = /^(?:please\s+)?(?:open|show)(?:\s+me)?\s+(.+?)(?:\s+please)?[!?]?$/i.exec(text.trim());
  if (!request) return null;
  const name = request[1].replace(/^["“']|["”']$/g, '').toLocaleLowerCase();
  // "Open Claude", "show Codex's files": teammates are addressable by name.
  const who = /^(?:the\s+)?(.+?)(?:['’]s)?(\s+(?:files|results|work|assets|deliverables))?$/.exec(name);
  const agent = who && agents.find(item => item.id.toLocaleLowerCase() === who[1] || item.name.toLocaleLowerCase() === who[1]);
  if (agent) return who![2] ? { select: `assets:${agent.id}`, reply: `${agent.name}’s files.` } : { select: `agent:${agent.id}`, reply: `Here is ${agent.name}.` };
  const matches = [...tasks, ...swarms].flatMap(task => task.artifacts.filter(file => file.name.toLocaleLowerCase() === name)
    .map(file => ({ task, file })));
  if (!matches.length) return null;
  if (matches.length > 1) return { reply: `I found ${matches.length} files called ${matches[0].file.name}. Point to the one you want in your teammate’s files.` };
  const { task, file } = matches[0];
  return { select: `artifact:${task.id}:${encodeURIComponent(file.path)}`, reply: `Here is ${file.name}.` };
}

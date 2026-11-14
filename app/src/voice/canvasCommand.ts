import type { AgentTask } from '../core/agentTypes';

// Local viewing commands never launch another agent or open an OS application.
export function canvasCommand(text: string, tasks: AgentTask[]): { select?: string; close?: boolean; reply: string } | null {
  if (/^(?:please\s+)?(?:close|dismiss)\s+(?:this|that|the)?\s*(?:preview|details|file)(?:\s+please)?[.!?]?$/i.test(text.trim())) {
    return { close: true, reply: 'Back to your team.' };
  }
  const request = /^(?:please\s+)?(?:open|show)(?:\s+me)?\s+(.+?)(?:\s+please)?[!?]?$/i.exec(text.trim());
  if (!request) return null;
  const name = request[1].replace(/^["“']|["”']$/g, '').toLocaleLowerCase();
  const matches = tasks.flatMap(task => task.artifacts.filter(file => file.name.toLocaleLowerCase() === name)
    .map(file => ({ task, file })));
  if (!matches.length) return null;
  if (matches.length > 1) return { reply: `I found ${matches.length} files called ${matches[0].file.name}. Point to the one you want in your teammate’s files.` };
  const { task, file } = matches[0];
  return { select: `artifact:${task.id}:${encodeURIComponent(file.path)}`, reply: `Here is ${file.name}.` };
}

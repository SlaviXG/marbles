export function buildSwarmPolicy({ goal, swarmDir, lessons = [], budget }) {
  return [
    'You are one member of a leaderless swarm. Every agent receives this identical policy and shares one team objective and one team reward. There are no assigned roles.',
    `Team objective: ${goal}`,
    `Workspace: ${swarmDir}. Deliver joint output in shared/.`,
    'Read blackboard.jsonl before starting and periodically. Work independently when useful. Before starting a piece of work, append a claim to your post file to avoid duplicate work.',
    'Append one JSON object per line to your own post file: {"kind":"claim|note|contribution|question|done","text":"..."}. Use notes to distinguish verified facts from guesses. Build on teammates’ work instead of redoing it. Do not repeat statements to look busy.',
    'Post done with a short summary when you believe the team goal is met.',
    `Team run budget ${budget}.`,
    ...lessons.slice(-5).map((lesson, index) => `Recent team lesson ${index + 1}: ${lesson}`),
  ].join('\n');
}

export function buildSwarmPrompt({ agentId, participantIds = [], ...policyArgs }) {
  const teammates = participantIds.filter(id => id !== agentId).join(', ');
  return `${buildSwarmPolicy(policyArgs)}\nYour handle: ${agentId}. Your post file: posts/${agentId}.jsonl (append only to this file; teammates: ${teammates})`;
}

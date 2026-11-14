import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const redactSecrets = (value) => String(value ?? '')
  .replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[^\s,}]+)\b/gi, '[redacted]')
  .replace(/\b(?:api[_-]?key|token|password|secret|[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*[^\s,}]+/gi, '[redacted]')
  .replace(/(["'](?:api[_-]?key|token|password|secret|authorization)["']\s*:\s*["'])[^"']+(["'])/gi, '$1[redacted]$2');
export const redact = value => redactSecrets(value).slice(0, 500);
const safe = redact;
const contentText = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => ['text', 'input_text', 'output_text'].includes(b?.type)).map(b => b.text).join(' ') : '';
export function parseLog(lines, kind) {
  const result = { prompt: null, messages: [], tools: [] };
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = row.timestamp || null;
    const msg = kind === 'claude' ? row.message : row.type === 'response_item' ? row.payload : null;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role === 'user' && !(kind === 'claude' && row.type !== 'user')) { const text = safe(contentText(msg.content)); if (text) result.prompt = { text, at }; }
    if (role === 'assistant') {
      const text = safe(contentText(msg.content));
      if (text) result.messages.push({ text, at });
    }
    const blocks = kind === 'claude' ? (Array.isArray(msg.content) ? msg.content : []) : row.payload?.type === 'custom_tool_call' ? [row.payload] : [];
    for (const block of blocks) if (block.type === 'tool_use' || block.type === 'custom_tool_call') {
      // Arguments may contain secrets. Show only names of argument fields.
      let input = block.input;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
      const args = input && typeof input === 'object' ? Object.keys(input).slice(0, 5).join(', ') : '';
      result.tools.push({ name: safe(block.name).slice(0, 80), args, at });
    }
  }
  result.messages = result.messages.slice(-8);
  result.tools = result.tools.slice(-12);
  return result;
}
export function parseCursorStream(lines) {
  const result = { prompt: null, messages: [], tools: [] };
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = row.timestamp || null;
    if (row.type === 'user') {
      const text = safe(contentText(row.message?.content ?? row.content));
      if (text) result.prompt = { text, at };
    } else if (row.type === 'assistant') {
      const text = safe(contentText(row.message?.content ?? row.content));
      if (text) result.messages.push({ text, at });
    } else if (row.type === 'tool_call') {
      const call = row.tool_call ?? {};
      const name = call.name ?? row.name ?? Object.keys(call)[0] ?? 'tool';
      result.tools.push({ name: safe(name).slice(0, 80), args: '', at });
    } else if (row.type === 'result' && typeof row.result === 'string') {
      const text = safe(row.result);
      if (text) result.messages.push({ text, at });
    }
  }
  result.messages = result.messages.slice(-8);
  result.tools = result.tools.slice(-12);
  return result;
}
async function newest(root, match, depth) {
  let best = null;
  async function visit(dir, level) {
    if (level > depth) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, level + 1);
      else if (entry.isFile() && match(entry.name)) { const stat = await fs.stat(full); if (!best || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs }; }
    }
  }
  await visit(root, 0);
  return best?.path;
}
export async function agentLog(provider, home = os.homedir(), cursorStdout = '') {
  if (provider === 'cursor') return cursorStdout?.trim()
    ? { available: true, ...parseCursorStream(cursorStdout.split(/\r?\n/)) }
    : { available: false, reason: 'No Cursor task output found' };
  if (!['claude', 'codex'].includes(provider)) return { available: false, reason: 'No known session log for this agent' };
  const file = provider === 'claude' ? await newest(path.join(home, '.claude/projects'), n => n.endsWith('.jsonl'), 2) : await newest(path.join(home, '.codex/sessions'), n => n.startsWith('rollout-') && n.endsWith('.jsonl'), 5);
  if (!file) return { available: false, reason: 'No session log found' };
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    const data = buffer.toString('utf8');
    const lines = data.slice(stat.size > length ? data.indexOf('\n') + 1 : 0).split(/\r?\n/);
    return { available: true, ...parseLog(lines, provider) };
  } finally { await handle.close(); }
}

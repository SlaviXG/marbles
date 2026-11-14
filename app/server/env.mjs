import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Where configuration comes from. Keys live in the repo-root `.env`, which git
// ignores, so a linked worktree (git worktree add) has none of its own. Those
// fall back to the main checkout's `.env`, and one file serves every worktree.
//
// Values are also re-read when a file changes, so adding or fixing a key takes
// effect on the next request instead of silently waiting for a restart.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function envFiles(root = repoRoot) {
  const files = [path.join(root, '.env')];
  try {
    // In a linked worktree `.git` is a file: "gitdir: <main>/.git/worktrees/<name>".
    const pointer = fs.readFileSync(path.join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1];
    if (pointer) files.push(path.join(path.resolve(root, pointer.trim(), '..', '..', '..'), '.env'));
  } catch { /* an ordinary checkout: `.git` is a directory */ }
  return [...new Set(files)].filter(file => fs.existsSync(file));
}

const fromFiles = new Set(); // names this module put into process.env (the shell did not)
let cache = { stamp: '', values: {} };

function readFiles(root) {
  const files = envFiles(root);
  const stamp = files.map(file => `${file}:${fs.statSync(file).mtimeMs}`).join('|');
  if (stamp !== cache.stamp) {
    const values = {};
    // The worktree's own file wins over the main checkout's.
    for (const file of [...files].reverse()) Object.assign(values, dotenv.parse(fs.readFileSync(file)));
    cache = { stamp, values };
  }
  return cache.values;
}

/** Load every env file into process.env once, without overriding the shell. */
export function loadEnv(root = repoRoot) {
  for (const [name, value] of Object.entries(readFiles(root))) {
    if (process.env[name] === undefined || fromFiles.has(name)) { process.env[name] = value; fromFiles.add(name); }
  }
  return envFiles(root);
}

/** The current value of a setting: the shell's if it set one, otherwise the env files as they are now. */
export function liveEnv(name, root = repoRoot) {
  if (process.env.VITEST) return process.env[name]; // tests never read a developer's real keys
  if (process.env[name] !== undefined && !fromFiles.has(name)) return process.env[name];
  try { return readFiles(root)[name] ?? process.env[name]; } catch { return process.env[name]; }
}

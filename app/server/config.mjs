import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// Machine-specific settings and keys: the repo-root .env, or the main
// checkout's when this is a linked worktree (see env.mjs).
loadEnv(repoRoot);

export function loadConfig() {
  const vaultDir = process.env.OBSIDIAN_VAULT_DIR;
  if (!vaultDir || !fs.existsSync(vaultDir)) {
    throw new Error(
      `OBSIDIAN_VAULT_DIR missing or not found: ${vaultDir}\nSet it in the repo-root .env (see .env.example).`,
    );
  }
  return {
    vaultDir,
    port: Number(process.env.VAULT_VIZ_PORT) || 5174,
  };
}

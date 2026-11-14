import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// Vault path is machine-specific: read it from the repo-root .env.
dotenv.config({ path: path.join(repoRoot, ".env") });

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
    agentOwner: process.env.MARBLES_AGENT_OWNER,
  };
}

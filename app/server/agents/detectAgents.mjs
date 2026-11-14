import { spawn } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentCatalog } from "./agentCatalog.mjs";

const VERSION_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 10_000;

function ownerName(value) {
  const owner = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return owner || "local";
}

function runtimeFor(platform, env) {
  return platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP) ? "wsl" : platform;
}

async function executableAt(file, platform) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCommand(command, pathDirs, platform, env) {
  if (!command || /[\\/\0\r\n]/.test(command)) return null;
  const extensions = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathDirs) {
    if (!dir) continue; // An empty PATH segment means cwd; do not probe it.
    for (const ext of extensions) {
      const candidate = path.join(dir, platform === "win32" ? command + ext.toLowerCase() : command);
      if (await executableAt(candidate, platform)) return candidate;
    }
  }
  return null;
}

async function findDesktop(apps, roots) {
  for (const root of roots) {
    for (const app of apps) {
      const candidate = path.join(root, app);
      try {
        if ((await fs.stat(candidate)).isDirectory()) return candidate;
      } catch { /* App is not installed here. */ }
    }
  }
  return null;
}

function readVersion(commandPath, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let child;
    const finish = (version) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(version);
    };
    try {
      child = spawn(commandPath, ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(0, 2048); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(0, 2048); });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const firstLine = (stdout || stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      finish(code === 0 && firstLine ? firstLine.slice(0, 160) : null);
    });
  });
}

// Adapted from https://github.com/stablyai/orca (MIT license): probe each
// catalog command and its dependencies, then resolve aliases to one agent ID.
export function createAgentDetector(options = {}) {
  const catalog = options.catalog ?? agentCatalog;
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  let cached = null;
  let expiresAt = 0;

  return function detectAgents() {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? os.homedir();
    const owner = ownerName(options.owner ?? env.MARBLES_AGENT_OWNER ?? os.userInfo().username);
    const pathValue = options.pathEnv ?? env.PATH ?? "";
    const key = JSON.stringify([pathValue, platform, homeDir, owner]);
    if (cached?.key === key && Date.now() < expiresAt) return cached.promise;

    const promise = (async () => {
      const runtime = runtimeFor(platform, env);
      const supported = catalog.filter((agent) => !(agent.detectUnsupportedRuntimes ?? []).includes(runtime));
      const pathDirs = pathValue.split(platform === "win32" ? ";" : ":");
      const desktopRoots = options.desktopRoots ?? ["/Applications", path.join(homeDir, "Applications")];
      const commands = [...new Set(supported.flatMap((agent) => [agent.detectCmd, ...(agent.detectCmdAliases ?? []), ...(agent.detectRequiredCommands ?? [])]))];
      const paths = new Map(await Promise.all(commands.map(async (command) => [command, await findCommand(command, pathDirs, platform, env)])));
      const found = await Promise.all(supported.map(async (agent) => {
        const required = (agent.detectRequiredCommands ?? []).every((command) => paths.get(command));
        const command = required && [agent.detectCmd, ...(agent.detectCmdAliases ?? [])].find((cmd) => paths.get(cmd));
        const cliPath = command ? paths.get(command) : null;
        const desktopPath = !cliPath && platform === "darwin" && agent.desktopApps?.length
          ? await findDesktop(agent.desktopApps, desktopRoots) : null;
        if (!cliPath && !desktopPath) return null;
        return {
          id: agent.id,
          instanceName: `${owner}-${agent.id}`,
          name: agent.name,
          kind: cliPath ? "cli" : "desktop",
          command: cliPath ? command : null,
          path: cliPath || desktopPath,
          version: cliPath && options.readVersions !== false ? await readVersion(cliPath, options.versionTimeoutMs ?? VERSION_TIMEOUT_MS) : null,
          available: true,
          codingAgent: agent.codingAgent === true,
        };
      }));
      return found.filter(Boolean);
    })();
    cached = { key, promise };
    expiresAt = Date.now() + cacheTtlMs;
    promise.catch(() => { if (cached?.promise === promise) cached = null; });
    return promise;
  };
}

export const detectAgents = createAgentDetector();

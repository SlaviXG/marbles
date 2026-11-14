import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentDetector } from "../agents/detectAgents.mjs";
import { agentCatalog } from "../agents/agentCatalog.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marbles-agents-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(home)]);
  return { root, bin, home };
}

async function command(bin, name, content = "#!/bin/sh\necho version-1\n") {
  const file = path.join(bin, name);
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}

describe("agent detection", () => {
  it("resolves catalog aliases and required commands from a fake PATH", async () => {
    const { bin, home } = await fixture();
    await Promise.all([command(bin, "kimi-code"), command(bin, "orca")]);
    const detect = createAgentDetector({
      catalog: agentCatalog.filter(({ id }) => ["kimi", "claude-agent-teams", "codex"].includes(id)),
      pathEnv: bin,
      homeDir: home,
      platform: "linux",
      readVersions: false,
    });
    expect(await detect()).toEqual([{
      id: "kimi", name: "Kimi", kind: "cli",
      command: "kimi-code", path: path.join(bin, "kimi-code"), version: null, available: true, codingAgent: false,
    }]);
    await command(bin, "claude");
    // A fresh detector sees the required command; the original stays cached briefly.
    const withClaude = createAgentDetector({ pathEnv: bin, homeDir: home, platform: "linux", readVersions: false,
      catalog: agentCatalog.filter(({ id }) => id === "claude-agent-teams") });
    expect((await withClaude()).map(({ id }) => id)).toEqual(["claude-agent-teams"]);
  });

  it("prefers CLI to desktop, and falls back to a macOS desktop bundle", async () => {
    const { bin, home } = await fixture();
    const applications = path.join(home, "Applications");
    await mkdir(path.join(applications, "Cursor.app"), { recursive: true });
    const catalog = agentCatalog.filter(({ id }) => id === "cursor");
    const desktop = createAgentDetector({ catalog, pathEnv: bin, homeDir: home, platform: "darwin", readVersions: false, desktopRoots: [applications] });
    expect((await desktop())[0]).toMatchObject({ id: "cursor", kind: "desktop", command: null,
      path: path.join(applications, "Cursor.app"), available: true, codingAgent: true });
    await command(bin, "cursor-agent");
    const cli = createAgentDetector({ catalog, pathEnv: bin, homeDir: home, platform: "darwin", readVersions: false, desktopRoots: [applications] });
    expect((await cli())[0]).toMatchObject({ id: "cursor", kind: "cli", command: "cursor-agent" });
  });

  it("marks only the three canvas coding agents in the catalog", () => {
    expect(agentCatalog.filter(({ codingAgent }) => codingAgent).map(({ id }) => id)).toEqual(["claude", "codex", "cursor"]);
  });

  it("uses only --version, times out, and caches the result", async () => {
    const { bin, home, root } = await fixture();
    const marker = path.join(root, "calls");
    await command(bin, "codex", `#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho call >> '${marker}'\necho codex-1.2\n`);
    const detect = createAgentDetector({ catalog: agentCatalog.filter(({ id }) => id === "codex"),
      pathEnv: bin, homeDir: home, platform: "linux", cacheTtlMs: 60_000 });
    const [first, second] = await Promise.all([detect(), detect()]);
    expect(first).toBe(second);
    expect(first[0].version).toBe("codex-1.2");
    expect(await detect()).toBe(first);
    await expect((await import("node:fs/promises")).readFile(marker, "utf8").then((s) => s.trim().split("\n"))).resolves.toEqual(["call"]);
  });
});

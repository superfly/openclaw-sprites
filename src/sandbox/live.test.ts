/**
 * Opt-in end-to-end check against the real Sprites API.
 *
 *   SPRITES_TOKEN=... npm run test:live
 *
 * Creates one sprite named `openclaw-livetest-<random>`, drives the backend
 * through the same calls OpenClaw makes (create, seed, validate workdir, exec
 * through the shim, file-bridge style shell commands), verifies the remote
 * utility contract the shared filesystem bridge needs, and deletes the sprite.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.SPRITES_LIVE === "1" && Boolean(process.env.SPRITES_TOKEN);

vi.mock("openclaw/plugin-sdk/sandbox", () => {
  const shellEscape = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const buildRemoteCommand = (argv: string[]) => argv.map(shellEscape).join(" ");
  return {
    shellEscape,
    buildRemoteCommand,
    sanitizeEnvVars: (env: Record<string, string | undefined>) => ({
      allowed: Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && k === "PATH")),
      blocked: [],
      warnings: [],
    }),
    buildValidatedExecRemoteCommand: (p: { command: string; workdir?: string }) =>
      buildRemoteCommand(["/bin/sh", "-c", p.workdir ? `cd ${shellEscape(p.workdir)} && ${p.command}` : p.command]),
    buildRemoteWorkdirValidationCommand: (p: { workdir: string; root: string }) =>
      buildRemoteCommand([
        "/bin/sh",
        "-c",
        'target="$1"; root="$2"; case "$target/" in "$root"/*|"$root/") ;; *) exit 1 ;; esac; [ -d "$target" ] && cd -- "$target" && pwd -P',
        "openclaw-validate-workdir",
        p.workdir,
        p.root,
      ]),
    createRemoteShellSandboxFsBridge: () => ({}),
    registerSandboxBackend: () => () => undefined,
    getSandboxBackendManager: () => null,
  };
});

import { createSpritesSandboxBackendFactory, createSpritesSandboxBackendManager } from "./backend.js";
import { SpritesGateway } from "../core/client.js";
import { resolveSpritesPluginConfig } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const shimPath = path.resolve(here, "..", "..", "dist", "src", "sandbox", "exec-shim.js");

describe.skipIf(!enabled)("live sprites backend", () => {
  const token = process.env.SPRITES_TOKEN ?? "";
  const namePrefix = "openclaw-livetest-";
  const scopeKey = `live:${Math.random().toString(36).slice(2, 10)}`;
  const pluginConfig = resolveSpritesPluginConfig({
    sandbox: { namePrefix, labels: ["openclaw-livetest"], checkpointAfterSetup: false },
  });
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const deps = {
    pluginConfig,
    resolveToken: async () => token,
    resolveInstanceId: async () => "live-test-gateway",
    logger,
    shimPath,
  };
  let workspaceDir = "";
  let runtimeId = "";

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sprites-live-"));
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hello from the gateway\n");
  });

  afterAll(async () => {
    if (runtimeId) {
      const manager = createSpritesSandboxBackendManager(deps);
      await manager.removeRuntime({
        entry: { containerName: runtimeId, sessionKey: scopeKey, createdAtMs: 0, lastUsedAtMs: 0, image: "default" },
        config: {} as never,
      });
      const gateway = new SpritesGateway({ token });
      expect(await gateway.getSprite(runtimeId)).toBeNull();
    }
  });

  it("creates a sprite, seeds the workspace, and runs commands through the shim", async () => {
    const factory = createSpritesSandboxBackendFactory(deps);
    const handle = await factory({
      sessionKey: scopeKey,
      scopeKey,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: {
        mode: "all",
        backend: "sprites",
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: "/tmp",
        docker: { setupCommand: "echo setup-ok > setup.txt" },
      },
    });
    runtimeId = handle.runtimeId;

    // Shared fs bridge contract: sh, python3, GNU stat, readlink.
    const contract = await handle.runShellCommand({
      script: 'command -v python3 && stat -c "%F|%s" -- "$1" && readlink -f -- "$1"',
      args: [pluginConfig.sandbox.remoteWorkspaceDir],
    });
    expect(contract.code).toBe(0);
    expect(contract.stdout.toString()).toContain("directory|");

    const seeded = await handle.runShellCommand({ script: 'cat -- "$1/hello.txt" "$1/setup.txt"', args: [pluginConfig.sandbox.remoteWorkspaceDir] });
    expect(seeded.stdout.toString()).toBe("hello from the gateway\nsetup-ok\n");

    expect(await handle.validateWorkdir?.(pluginConfig.sandbox.remoteWorkspaceDir)).toBe(pluginConfig.sandbox.remoteWorkspaceDir);
    expect(await handle.validateWorkdir?.("/etc")).toBeNull();

    const spec = await handle.buildExecSpec({
      command: "echo \"$GREETING from $(pwd)\"; cat; exit 4",
      workdir: pluginConfig.sandbox.remoteWorkspaceDir,
      env: { GREETING: "hi there" },
      usePty: false,
    });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), { env: spec.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end("piped stdin\n");
    });
    expect(result.stdout).toBe(`hi there from ${pluginConfig.sandbox.remoteWorkspaceDir}\npiped stdin\n`);
    expect(result.code).toBe(4);
    await handle.finalizeExec?.({ status: "completed", exitCode: 4, timedOut: false, token: spec.finalizeToken });
    expect(logs.some((l) => l.includes("is ready"))).toBe(true);
  }, 300_000);
});

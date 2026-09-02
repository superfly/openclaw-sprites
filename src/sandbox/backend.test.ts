import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real SDK module refuses to load on Node runtimes OpenClaw does not
// support, so mirror the handful of helpers the backend uses.
vi.mock("openclaw/plugin-sdk/sandbox", () => {
  const shellEscape = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const buildRemoteCommand = (argv: string[]) => argv.map(shellEscape).join(" ");
  return {
    shellEscape,
    buildRemoteCommand,
    sanitizeEnvVars: (env: Record<string, string | undefined>) => ({
      allowed: Object.fromEntries(
        Object.entries(env).filter(([k, v]) => v !== undefined && !/TOKEN|SECRET|KEY/i.test(k)),
      ),
      blocked: [],
      warnings: [],
    }),
    buildValidatedExecRemoteCommand: (p: { command: string; workdir?: string }) =>
      buildRemoteCommand(["/bin/sh", "-c", p.workdir ? `cd ${shellEscape(p.workdir)} && ${p.command}` : p.command]),
    buildRemoteWorkdirValidationCommand: (p: { workdir: string; root: string }) =>
      buildRemoteCommand(["/bin/sh", "-c", "validate", "openclaw-validate-workdir", p.workdir, p.root]),
    createRemoteShellSandboxFsBridge: (p: { runtime: unknown }) => ({ bridgeFor: p.runtime }),
    registerSandboxBackend: () => () => undefined,
    getSandboxBackendManager: () => null,
  };
});

import {
  SpritesSandboxBackendImpl,
  buildSpriteLabels,
  buildSpriteName,
  createSpritesSandboxBackendFactory,
  createSpritesSandboxBackendManager,
  configLabel,
  instanceLabel,
  readyMarkerPath,
  scopeHash,
  streamTarDirectory,
} from "./backend.js";
import { SpritesGateway } from "../core/client.js";
import { resolveSpritesPluginConfig, type ResolvedSpritesPluginConfig, type ResolvedSpritesSandboxConfig } from "../config.js";
import { FakeSpritesServer } from "../test-support/fake-sprites-server.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const TEST_INSTANCE_ID = "gateway-test";

function makeDeps(
  server: FakeSpritesServer,
  overrides: Partial<Omit<ResolvedSpritesPluginConfig, "sandbox">> & { sandbox?: Partial<ResolvedSpritesSandboxConfig> } = {},
) {
  const base = resolveSpritesPluginConfig({ apiUrl: server.url });
  const pluginConfig: ResolvedSpritesPluginConfig = {
    ...base,
    ...overrides,
    sandbox: { ...base.sandbox, ...overrides.sandbox },
  };
  return {
    pluginConfig,
    resolveToken: async () => "org/1/2/tok",
    resolveInstanceId: async () => TEST_INSTANCE_ID,
    logger,
    shimPath: "/plugin/dist/src/sandbox/exec-shim.js",
    createClient: (token: string) =>
      new SpritesGateway({ token, apiUrl: server.url, wake: { timeoutMs: 5000, maxRetryDelayMs: 20 } }),
  };
}

describe("naming", () => {
  it("derives a stable, installation-scoped sprite name and labels", () => {
    const name = buildSpriteName("openclaw-", TEST_INSTANCE_ID, "agent:main:workspace:abc");
    expect(name).toMatch(/^openclaw-[0-9a-f]{12}$/);
    expect(buildSpriteName("openclaw-", TEST_INSTANCE_ID, "agent:main:workspace:abc")).toBe(name);
    expect(buildSpriteName("openclaw-", "another-gateway", "agent:main:workspace:abc")).not.toBe(name);
    expect(buildSpriteName("openclaw-", TEST_INSTANCE_ID, "agent:other")).not.toBe(name);
    const cfg = resolveSpritesPluginConfig({ sandbox: { labels: ["team-a"] } });
    expect(buildSpriteLabels(cfg, TEST_INSTANCE_ID, "agent:main")).toEqual([
      "openclaw",
      instanceLabel(TEST_INSTANCE_ID),
      `openclaw-scope-${scopeHash("agent:main")}`,
      `openclaw-config-${configLabel(cfg)}`,
      "team-a",
    ]);

    const operationalOnly = resolveSpritesPluginConfig({
      sandbox: {
        labels: ["another-label"],
        checkpointAfterSetup: true,
        maxRunAfterDisconnect: "45s",
      },
    });
    expect(configLabel(operationalOnly)).toBe(configLabel(resolveSpritesPluginConfig(undefined)));
    expect(
      configLabel(resolveSpritesPluginConfig({ sandbox: { privileges: { profile: "minimal" } } })),
    ).not.toBe(configLabel(operationalOnly));
  });
});

describe("SpritesSandboxBackendImpl", () => {
  let server: FakeSpritesServer;
  let workspaceDir: string;
  let agentDir: string;

  beforeEach(async () => {
    server = new FakeSpritesServer();
    await server.start();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sprites-"));
    workspaceDir = path.join(root, "workspace");
    agentDir = path.join(root, "agent");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hi");
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "rules");
    logger.info.mockClear();
  });
  afterEach(async () => {
    await server.stop();
  });

  function createParams(overrides: Record<string, unknown> = {}) {
    return {
      sessionKey: "agent:main:main",
      scopeKey: "agent:main",
      workspaceDir,
      agentWorkspaceDir: agentDir,
      cfg: {
        mode: "all" as const,
        backend: "sprites",
        scope: "agent" as const,
        workspaceAccess: "rw" as const,
        workspaceRoot: "/tmp",
        docker: { env: { FROM_CFG: "1" } },
      },
      ...overrides,
    };
  }

  it("creates the sprite lazily, applies policies, seeds both workspaces, and stages exec scripts", async () => {
    const deps = makeDeps(server, {
      sandbox: {
        network: { rules: [{ include: "defaults" }] },
        privileges: { profile: "minimal" },
        checkpointAfterSetup: true,
      },
    });
    const factory = createSpritesSandboxBackendFactory(deps);
    const configuredParams = createParams({
      cfg: { ...createParams().cfg, docker: { env: { FROM_CFG: "1" }, setupCommand: "npm ci" } },
    });
    const handle = await factory(configuredParams);
    expect(handle.id).toBe("sprites");
    expect(handle.runtimeId).toBe(buildSpriteName("openclaw-", TEST_INSTANCE_ID, "agent:main"));
    expect(handle.workdir).toBe("/home/sprite/workspace");
    expect(handle.configLabel).toBe(configLabel(deps.pluginConfig));
    expect(server.sprites.size).toBe(0);

    const spec = await handle.buildExecSpec({ command: "echo $X", workdir: "/home/sprite/workspace", env: { X: "it's" }, usePty: false });
    const sprite = server.sprites.get(handle.runtimeId)!;
    expect(sprite.labels).toEqual(
      expect.arrayContaining([
        "openclaw",
        instanceLabel(TEST_INSTANCE_ID),
        expect.stringMatching(/^openclaw-scope-/),
        expect.stringMatching(/^openclaw-config-cfg-/),
      ]),
    );
    expect(sprite.networkPolicy).toEqual({ rules: [{ include: "defaults" }] });
    expect(sprite.privilegesPolicy).toEqual({ profile: "minimal" });
    expect(sprite.files.has("/home/sprite/workspace/")).toBe(true);
    expect(sprite.files.has("/home/sprite/agent/")).toBe(true);
    expect(Number(sprite.files.get("/home/sprite/workspace/.seeded-bytes"))).toBeGreaterThan(0);
    expect(sprite.files.get("/setup-ran")).toBe("npm ci");
    const setupRequest = server.execLog.find((entry) => entry.request.argv[2]?.includes('sh -lc "$2"'));
    expect(setupRequest?.request.argv[2]).toContain("export FROM_CFG='1'");
    expect(sprite.checkpoints.map((c) => c.comment)).toEqual(["openclaw:setup"]);
    expect(sprite.files.has("/home/sprite/.openclaw-sandbox-ready")).toBe(true);

    const staged = [...sprite.files.entries()].find(([k]) => k.endsWith("/exec.sh"));
    expect(staged).toBeDefined();
    expect(staged![1]).toContain(`export X='it'"'"'s'`);
    expect(staged![1]).toContain("exec '/bin/sh' '-c' 'cd '\"'\"'/home/sprite/workspace'\"'\"' && echo $X'");
    expect(spec.argv.slice(0, 2)).toEqual([process.execPath, "/plugin/dist/src/sandbox/exec-shim.js"]);
    expect(spec.argv).toContain("--sprite");
    expect(spec.argv).toContain(handle.runtimeId);
    expect(spec.argv.at(-2)).toBe("/bin/sh");
    expect(spec.argv.at(-1)).toMatch(/^\/tmp\/openclaw-exec-.*\/exec\.sh$/);
    expect(spec.argv).not.toContain("--tty");
    expect(spec.stdinMode).toBe("pipe-open");
    expect(spec.env.OPENCLAW_SPRITES_TOKEN).toBe("org/1/2/tok");
    expect(spec.env.OPENCLAW_SPRITES_API_URL).toBe(server.url);
    expect(spec.env.OPENCLAW_SPRITES_WAKE_TIMEOUT_MS).toBe("120000");

    const pty = await handle.buildExecSpec({ command: "bash", env: {}, usePty: true });
    expect(pty.argv).toContain("--tty");
    const ptyScript = [...sprite.files.values()].find((v) => v.includes("TERM="));
    expect(ptyScript).toContain("export TERM='xterm-256color'");
    // A second handle for the same scope reuses the seeded sprite instead of re-seeding.
    const again = await factory(configuredParams);
    const seededBefore = sprite.files.get("/home/sprite/workspace/.seeded-bytes");
    await again.runShellCommand({ script: "true" });
    expect(sprite.files.get("/home/sprite/workspace/.seeded-bytes")).toBe(seededBefore);
    expect(server.sprites.size).toBe(1);
  });

  it("validates workdirs against the remote roots", async () => {
    const handle = await createSpritesSandboxBackendFactory(makeDeps(server))(createParams());
    expect(await handle.validateWorkdir?.("/home/sprite/workspace")).toBe("/home/sprite/workspace");
    expect(await handle.validateWorkdir?.("/home/sprite/agent")).toBe("/home/sprite/agent");
    expect(await handle.validateWorkdir?.("/etc")).toBeNull();
  });

  it("surfaces setupCommand failures and non-zero shell commands", async () => {
    const handle = await createSpritesSandboxBackendFactory(makeDeps(server))(
      createParams({ cfg: { ...createParams().cfg, docker: { setupCommand: "make fail" } } }),
    );
    await expect(handle.runShellCommand({ script: "true" })).rejects.toThrow(/setupCommand failed .*setup exploded/);
    // After a failed ensure, the next call retries the whole bootstrap.
    const attempts = () => server.execLog.filter((e) => e.request.argv[2]?.includes('sh -lc "$2"')).length;
    expect(attempts()).toBe(1);
    await expect(handle.runShellCommand({ script: "true" })).rejects.toThrow(/setupCommand failed/);
    expect(attempts()).toBe(2);
  });

  it("reapplies policies when a transient failure leaves an incomplete sprite", async () => {
    server.networkPolicyFailuresLeft = 1;
    const deps = makeDeps(server, { sandbox: { network: { rules: [{ domain: "example.com" }] } } });
    const handle = await createSpritesSandboxBackendFactory(deps)(createParams());
    await expect(handle.runShellCommand({ script: "true" })).rejects.toThrow();
    const sprite = server.sprites.get(handle.runtimeId)!;
    expect(sprite.networkPolicy).toBeUndefined();
    expect(sprite.files.has(readyMarkerPath("/home/sprite/workspace"))).toBe(false);

    await expect(handle.runShellCommand({ script: "true" })).resolves.toMatchObject({ code: 0 });
    expect(sprite.networkPolicy).toEqual({ rules: [{ domain: "example.com" }] });
  });

  it("keeps the ready marker in the post-setup checkpoint", async () => {
    const deps = makeDeps(server, { sandbox: { checkpointAfterSetup: true } });
    const handle = await createSpritesSandboxBackendFactory(deps)(createParams());
    await handle.runShellCommand({ script: "true" });
    const sprite = server.sprites.get(handle.runtimeId)!;
    const checkpoint = sprite.checkpoints[0]!;
    const marker = readyMarkerPath("/home/sprite/workspace");
    expect(checkpoint.files.has(marker)).toBe(true);
    sprite.files.delete(marker);
    await deps.createClient("t").restoreCheckpoint(handle.runtimeId, checkpoint.id);
    expect(sprite.files.has(marker)).toBe(true);
  });

  it("rejects an existing runtime whose bootstrap configuration drifted", async () => {
    const first = makeDeps(server);
    const initialParams = createParams({
      cfg: {
        ...createParams().cfg,
        docker: { env: { SETUP_VALUE: "first" }, setupCommand: "echo setup" },
      },
    });
    const original = await createSpritesSandboxBackendFactory(first)(initialParams);
    await original.runShellCommand({ script: "true" });

    const changedOpenClawConfig = await createSpritesSandboxBackendFactory(first)(
      createParams({
        cfg: {
          ...createParams().cfg,
          docker: { env: { SETUP_VALUE: "changed" }, setupCommand: "echo setup" },
        },
      }),
    );
    await expect(changedOpenClawConfig.runShellCommand({ script: "true" })).rejects.toThrow(
      /different sandbox configuration/,
    );

    const relocated = makeDeps(server, {
      sandbox: { remoteWorkspaceDir: "/srv/workspace", remoteAgentWorkspaceDir: "/srv/agent" },
    });
    const relocatedHandle = await createSpritesSandboxBackendFactory(relocated)(initialParams);
    await expect(relocatedHandle.runShellCommand({ script: "true" })).rejects.toThrow(
      /different sandbox configuration/,
    );

    const changed = makeDeps(server, { sandbox: { privileges: { profile: "minimal" } } });
    const next = await createSpritesSandboxBackendFactory(changed)(initialParams);
    expect(next.runtimeId).toBe(original.runtimeId);
    await expect(next.runShellCommand({ script: "true" })).rejects.toThrow(/different sandbox configuration/);

    const manager = createSpritesSandboxBackendManager(changed);
    const described = await manager.describeRuntime({
      entry: {
        containerName: original.runtimeId,
        sessionKey: "s",
        createdAtMs: 0,
        lastUsedAtMs: 0,
        image: configLabel(changed.pluginConfig),
      },
      config: {} as never,
    });
    expect(described.configLabelMatch).toBe(false);
    expect(described.actualConfigLabel).toBe(configLabel(first.pluginConfig));
  });

  it("applies operational config changes without requiring recreation", async () => {
    const initial = makeDeps(server);
    const first = await createSpritesSandboxBackendFactory(initial)(createParams());
    await first.runShellCommand({ script: "true" });

    const operational = makeDeps(server, {
      sandbox: {
        labels: ["new-label"],
        checkpointAfterSetup: true,
        maxRunAfterDisconnect: "45s",
      },
    });
    const next = await createSpritesSandboxBackendFactory(operational)(createParams());
    await expect(next.runShellCommand({ script: "true" })).resolves.toMatchObject({ code: 0 });
    const last = server.execLog.at(-1)!;
    expect(last.request.maxRunAfterDisconnect).toBe("45s");
  });

  it("refreshes materialized skills when a new read-write handle starts", async () => {
    const skillsDir = path.join(path.dirname(workspaceDir), "skills");
    await fs.mkdir(skillsDir);
    await fs.writeFile(path.join(skillsDir, "skill.md"), "first");
    const deps = makeDeps(server);
    const factory = createSpritesSandboxBackendFactory(deps);
    const params = createParams({ skillsWorkspaceDir: skillsDir });
    const first = await factory(params);
    await first.runShellCommand({ script: "true" });
    const sprite = server.sprites.get(first.runtimeId)!;
    const seededPath = "/home/sprite/workspace/.openclaw/sandbox-skills/.seeded-bytes";
    expect(sprite.files.has(seededPath)).toBe(true);
    const skillUploads = () =>
      server.execLog.filter(
        (entry) =>
          entry.request.argv[2]?.includes("tar -xf -") &&
          entry.request.argv.includes("/home/sprite/workspace/.openclaw/sandbox-skills"),
      ).length;
    const uploadsBefore = skillUploads();

    await fs.writeFile(path.join(skillsDir, "skill.md"), "second version with more bytes");
    const second = await factory(params);
    await second.runShellCommand({ script: "true" });
    expect(skillUploads()).toBe(uploadsBefore + 1);
  });

  it("refuses to adopt a sprite that was not created by the plugin", async () => {
    server.addSprite(buildSpriteName("openclaw-", TEST_INSTANCE_ID, "agent:main"), { labels: ["someone-else"] });
    const handle = await createSpritesSandboxBackendFactory(makeDeps(server))(createParams());
    await expect(handle.runShellCommand({ script: "true" })).rejects.toThrow(/not owned by this Gateway/);
  });

  it("rejects docker binds", async () => {
    const deps = makeDeps(server);
    await expect(
      createSpritesSandboxBackendFactory(deps)(createParams({ cfg: { ...createParams().cfg, docker: { binds: ["/a:/b:ro"] } } })),
    ).rejects.toThrow(/binds/);
  });

  it("logs the sleep state of an existing sprite and wakes it on first use", async () => {
    const deps = makeDeps(server);
    const factory = createSpritesSandboxBackendFactory(deps);
    const first = await factory(createParams());
    await first.runShellCommand({ script: "true" });
    const sprite = server.sprites.get(first.runtimeId)!;
    sprite.status = "cold";
    sprite.startingResponsesLeft = 2;
    logger.info.mockClear();
    const handle = await factory(createParams());
    const result = await handle.runShellCommand({ script: "true" });
    expect(result.code).toBe(0);
    expect(logger.info.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/asleep \(cold/)]),
    );
    expect(sprite.status).toBe("running");
  });

  it("manager describes and removes only plugin-owned sprites", async () => {
    const deps = makeDeps(server);
    const manager = createSpritesSandboxBackendManager(deps);
    const label = configLabel(deps.pluginConfig);
    const entry = { containerName: "openclaw-aaaa", sessionKey: "s", createdAtMs: 0, lastUsedAtMs: 0, image: label };
    expect(await manager.describeRuntime({ entry, config: {} as never })).toEqual({
      running: false,
      actualConfigLabel: undefined,
      configLabelMatch: false,
    });
    server.addSprite("openclaw-aaaa", { labels: buildSpriteLabels(deps.pluginConfig, TEST_INSTANCE_ID, "scope") });
    expect((await manager.describeRuntime({ entry, config: {} as never })).running).toBe(true);
    await manager.removeRuntime({ entry, config: {} as never });
    expect(server.sprites.has("openclaw-aaaa")).toBe(false);
    server.addSprite("openclaw-bbbb", { labels: [] });
    await expect(
      manager.removeRuntime({ entry: { ...entry, containerName: "openclaw-bbbb" }, config: {} as never }),
    ).rejects.toThrow(/Refusing to delete/);
    await manager.removeRuntime({ entry: { ...entry, containerName: "missing" }, config: {} as never });
  });

  it("keeps a sprite awake only when keepAwakeMinutes is set", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps(server, { wake: { timeoutMs: 5000, maxRetryDelayMs: 20, keepAwakeMinutes: 10 } });
      const impl = new SpritesSandboxBackendImpl({
        deps,
        client: deps.createClient("t"),
        token: "t",
        instanceId: TEST_INSTANCE_ID,
        createParams: createParams(),
      });
      const handle = impl.asHandle();
      await handle.runShellCommand({ script: "true" });
      const pings = () => server.execLog.filter((e) => e.request.argv[0] === "true").length;
      const before = pings();
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 10);
      await vi.waitFor(() => expect(pings()).toBe(before + 1), { timeout: 3000, interval: 10 });
      // 8 minutes after the last tool call the sprite is still pinged; at 12 the window has closed.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      await vi.waitFor(() => expect(pings()).toBe(before + 2), { timeout: 3000, interval: 10 });
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      await vi.waitFor(() => expect(logger.info.mock.calls.some((c) => String(c[0]).includes("keep-awake window"))).toBe(true), { timeout: 3000, interval: 10 });
      await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
      expect(pings()).toBe(before + 2);
      impl.stopKeepAwake();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamTarDirectory", () => {
  it("delivers the full archive to a consumer that attaches late", async () => {
    // The real consumer is client.exec(), which awaits an ensureAwake HTTP
    // round trip and a WebSocket handshake before it reads the stream. By
    // then tar has exited, and Node's flushStdio() has resumed and discarded
    // unconsumed stdio. Regression test for the resulting empty upload
    // ("tar: This does not look like a tar archive" in the sprite).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tar-test-"));
    try {
      await fs.writeFile(path.join(dir, "file.txt"), "payload".repeat(64));
      const bytes = await streamTarDirectory(dir, async (archive) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        let total = 0;
        for await (const chunk of archive) {
          total += chunk.length;
        }
        return total;
      });
      expect(bytes).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

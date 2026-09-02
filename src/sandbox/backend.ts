/**
 * The Sprites sandbox backend: one sprite per OpenClaw sandbox scope.
 *
 * Responsibilities:
 *  - lazily create the sprite, apply policies, seed the workspace, run setup
 *  - turn `exec` into a local shim process bridged to the sprite's exec socket
 *  - run buffered shell scripts for OpenClaw's shared remote filesystem bridge
 *  - keep the sleep/wake cycle explicit: every remote call is wake-aware,
 *    every wake is logged once, and an optional keep-awake heartbeat can hold
 *    the sprite up between tool calls.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { PluginLogger } from "openclaw/plugin-sdk/core";
import {
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  sanitizeEnvVars,
  shellEscape,
  type CreateSandboxBackendParams,
  type RemoteShellSandboxHandle,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
  type SandboxBackendFactory,
  type SandboxBackendHandle,
  type SandboxBackendManager,
  type SandboxRegistryEntry,
} from "openclaw/plugin-sdk/sandbox";
import { SpritesGateway } from "../core/client.js";
import type { ResolvedSpritesPluginConfig } from "../config.js";
import { describeSpriteStatus, parseSpriteStatus } from "../core/protocol.js";
import type { WakeEvent } from "../core/wake.js";

export const SPRITES_BACKEND_ID = "sprites";
export const OWNER_LABEL = "openclaw";
export const SETUP_CHECKPOINT_COMMENT = "openclaw:setup";
/** Marker written next to the workspace root once seeding and setup finished. */
export function readyMarkerPath(remoteWorkspaceDir: string): string {
  return path.posix.join(path.posix.dirname(remoteWorkspaceDir), ".openclaw-sandbox-ready");
}
const SCOPE_LABEL_PREFIX = "openclaw-scope-";
const INSTANCE_LABEL_PREFIX = "openclaw-instance-";
const CONFIG_LABEL_PREFIX = "openclaw-config-";
const READY_MARKER_VERSION = "openclaw-sprites-ready-v1";
const KEEP_AWAKE_TICK_MS = 4 * 60 * 1000;

export type SpritesSandboxHandle = SandboxBackendHandle & RemoteShellSandboxHandle;

export type SpritesBackendDeps = {
  pluginConfig: ResolvedSpritesPluginConfig;
  /** Resolves the API token; called lazily so SecretRefs resolve at use time. */
  resolveToken: () => Promise<string>;
  /** Stable identity for this Gateway installation. */
  resolveInstanceId: () => Promise<string>;
  logger: PluginLogger;
  /** Absolute path of the compiled exec shim. */
  shimPath?: string;
  /** Overridable for tests. */
  createClient?: (token: string) => SpritesGateway;
};

// ------------------------------------------------------------------ naming

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function scopeHash(scopeKey: string): string {
  return shortHash(scopeKey.trim() || "shared");
}

export function instanceLabel(instanceId: string): string {
  return `${INSTANCE_LABEL_PREFIX}${shortHash(instanceId)}`;
}

export function buildSpriteName(namePrefix: string, instanceId: string, scopeKey: string): string {
  return `${namePrefix}${shortHash(`${instanceId}\0${scopeKey.trim() || "shared"}`)}`;
}

export function buildSpriteLabels(
  pluginConfig: ResolvedSpritesPluginConfig,
  instanceId: string,
  scopeKey: string,
): string[] {
  const labels = new Set<string>([
    OWNER_LABEL,
    instanceLabel(instanceId),
    `${SCOPE_LABEL_PREFIX}${scopeHash(scopeKey)}`,
    `${CONFIG_LABEL_PREFIX}${configLabel(pluginConfig)}`,
  ]);
  for (const label of pluginConfig.sandbox.labels) {
    labels.add(label);
  }
  return [...labels];
}

export function isOwnedSprite(labels: readonly string[] | undefined, instanceId?: string): boolean {
  const values = labels ?? [];
  return values.includes(OWNER_LABEL) && (!instanceId || values.includes(instanceLabel(instanceId)));
}

export function configLabel(pluginConfig: ResolvedSpritesPluginConfig): string {
  return `cfg-${shortHash(stableJson(bootstrapPluginConfig(pluginConfig)), 16)}`;
}

function bootstrapPluginConfig(pluginConfig: ResolvedSpritesPluginConfig): object {
  const sandbox = pluginConfig.sandbox;
  return {
    network: sandbox.network,
    privileges: sandbox.privileges,
    runtime: sandbox.runtime,
    sprite: sandbox.sprite,
    remoteWorkspaceDir: sandbox.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: sandbox.remoteAgentWorkspaceDir,
  };
}

function actualConfigLabel(labels: readonly string[] | undefined): string | undefined {
  return labels?.find((label) => label.startsWith(CONFIG_LABEL_PREFIX))?.slice(CONFIG_LABEL_PREFIX.length);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveShimPath(): string {
  return fileURLToPath(new URL("./exec-shim.js", import.meta.url));
}

// ------------------------------------------------------------------ wake logging

export function createWakeLogger(logger: PluginLogger): (event: WakeEvent) => void {
  return (event) => {
    if (event.type === "waking" && event.attempt === 1) {
      logger.info(`sprites: sprite ${event.spriteName} is asleep; waking it (this can take a few seconds)`);
    } else if (event.type === "awake") {
      logger.info(
        `sprites: sprite ${event.spriteName} is awake after ${(event.waitedMs / 1000).toFixed(1)}s`,
      );
    } else if (event.type === "timeout") {
      logger.error(
        `sprites: sprite ${event.spriteName} did not wake within ${(event.waitedMs / 1000).toFixed(0)}s; ` +
          "raise plugins.entries.sprites.config.wake.timeoutSeconds or run `openclaw sprites status`",
      );
    }
  };
}

// ------------------------------------------------------------------ factory / manager

export function createSpritesSandboxBackendFactory(deps: SpritesBackendDeps): SandboxBackendFactory {
  return async (createParams) => {
    const [token, instanceId] = await Promise.all([deps.resolveToken(), deps.resolveInstanceId()]);
    const client = makeClient(deps, token);
    const impl = new SpritesSandboxBackendImpl({ deps, client, token, instanceId, createParams });
    return impl.asHandle();
  };
}

export function createSpritesSandboxBackendManager(deps: SpritesBackendDeps): SandboxBackendManager {
  return {
    async describeRuntime({ entry }) {
      const [token, instanceId] = await Promise.all([deps.resolveToken(), deps.resolveInstanceId()]);
      const client = makeClient(deps, token);
      const sprite = await client.getSprite(entry.containerName);
      const desired = configLabel(deps.pluginConfig);
      const actual = actualConfigLabel(sprite?.labels);
      return {
        running: sprite !== null && isOwnedSprite(sprite.labels, instanceId),
        actualConfigLabel: actual,
        configLabelMatch: actual === desired && entry.image === desired,
      };
    },
    async removeRuntime({ entry }) {
      const [token, instanceId] = await Promise.all([deps.resolveToken(), deps.resolveInstanceId()]);
      const client = makeClient(deps, token);
      const sprite = await client.getSprite(entry.containerName);
      if (!sprite) {
        return;
      }
      if (!isOwnedSprite(sprite.labels, instanceId)) {
        throw new Error(
          `Refusing to delete sprite ${entry.containerName}: it is not owned by this Gateway instance.`,
        );
      }
      deps.logger.info(`sprites: deleting sprite ${entry.containerName}`);
      await client.deleteSprite(entry.containerName);
    },
  };
}

export function resolveSpritesWorkdir(deps: SpritesBackendDeps): string {
  return deps.pluginConfig.sandbox.remoteWorkspaceDir;
}

function makeClient(deps: SpritesBackendDeps, token: string): SpritesGateway {
  if (deps.createClient) {
    return deps.createClient(token);
  }
  return new SpritesGateway({
    token,
    apiUrl: deps.pluginConfig.apiUrl,
    wake: deps.pluginConfig.wake,
    onWake: createWakeLogger(deps.logger),
    requestTimeoutMs: deps.pluginConfig.timeoutMs,
  });
}

// ------------------------------------------------------------------ backend implementation

type PendingExec = { remoteDir: string };
type StreamingCommandParams = Omit<SandboxBackendCommandParams, "stdin"> & {
  stdin?: Buffer | string | AsyncIterable<Uint8Array | string>;
};

export class SpritesSandboxBackendImpl {
  private handle: SpritesSandboxHandle | null = null;
  private ensurePromise: Promise<void> | null = null;
  private skillsRefreshPromise: Promise<void> | null = null;
  private keepAwakeTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  readonly spriteName: string;
  readonly remoteWorkspaceDir: string;
  readonly remoteAgentWorkspaceDir: string;
  private readonly readyMarkerValue: string;

  constructor(
    private readonly params: {
      deps: SpritesBackendDeps;
      client: SpritesGateway;
      token: string;
      instanceId: string;
      createParams: CreateSandboxBackendParams;
    },
  ) {
    const { pluginConfig } = params.deps;
    this.spriteName = buildSpriteName(
      pluginConfig.sandbox.namePrefix,
      params.instanceId,
      params.createParams.scopeKey,
    );
    this.remoteWorkspaceDir = pluginConfig.sandbox.remoteWorkspaceDir;
    this.remoteAgentWorkspaceDir = pluginConfig.sandbox.remoteAgentWorkspaceDir;
    const setupCommand = params.createParams.cfg.docker.setupCommand?.trim() ?? "";
    this.readyMarkerValue = `${READY_MARKER_VERSION}:${shortHash(
      stableJson({
        plugin: bootstrapPluginConfig(pluginConfig),
        workspaceAccess: params.createParams.cfg.workspaceAccess,
        setupCommand,
        setupEnv: setupCommand ? (params.createParams.cfg.docker.env ?? {}) : undefined,
      }),
      24,
    )}`;
    if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error(
        "The sprites sandbox backend does not support sandbox.docker.binds; seed files into the workspace instead.",
      );
    }
  }

  asHandle(): SpritesSandboxHandle {
    if (this.handle) {
      return this.handle;
    }
    const { pluginConfig } = this.params.deps;
    const handle: SpritesSandboxHandle = {
      id: SPRITES_BACKEND_ID,
      runtimeId: this.spriteName,
      runtimeLabel: this.spriteName,
      workdir: this.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: configLabel(pluginConfig),
      configLabelKind: "Config",
      workdirValidation: "backend",
      validateWorkdir: (workdir) => this.validateWorkdir(workdir),
      workdirRoots: [this.remoteWorkspaceDir, this.remoteAgentWorkspaceDir],
      remoteWorkspaceDir: this.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.remoteAgentWorkspaceDir,
      buildExecSpec: (execParams) => this.buildExecSpec(execParams),
      finalizeExec: async ({ status, token }) => {
        await this.finalizeExec(status, token as PendingExec | undefined);
      },
      runShellCommand: (command) => this.runRemoteShellScript(command),
      runRemoteShellScript: (command) => this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) => createRemoteShellSandboxFsBridge({ sandbox, runtime: handle }),
    };
    this.handle = handle;
    return handle;
  }

  // -------------------------------------------------------------- exec

  async buildExecSpec(execParams: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<{
    argv: string[];
    env: NodeJS.ProcessEnv;
    stdinMode: "pipe-open";
    finalizeToken: PendingExec;
  }> {
    const remoteWorkdir = execParams.workdir ?? this.remoteWorkspaceDir;
    const remoteCommand = buildValidatedExecRemoteCommand({
      command: execParams.command,
      workdir: remoteWorkdir,
      env: {},
    });
    await this.ensureRuntime();
    await this.ensureSkillsCurrent();

    // Stage the command as a script so env values never go through argv or the
    // query string, then exec it with /bin/sh through the shim.
    const env =
      execParams.usePty && execParams.env.TERM === undefined
        ? { TERM: "xterm-256color", ...execParams.env }
        : execParams.env;
    const envExports = buildEnvExports(env);
    const remoteDir = `/tmp/openclaw-exec-${randomUUID()}`;
    const remoteScript = `${remoteDir}/exec.sh`;
    const script = [
      "#!/bin/sh",
      "set -e",
      `rm -rf -- ${shellEscape(remoteDir)}`,
      ...envExports,
      `exec ${remoteCommand}`,
      "",
    ].join("\n");
    await this.runRemoteShellScriptRaw({
      script: 'umask 077 && mkdir -- "$1" && cat > "$1/exec.sh" && chmod 700 "$1/exec.sh"',
      args: [remoteDir],
      stdin: script,
    });

    const { pluginConfig } = this.params.deps;
    const shimPath = this.params.deps.shimPath ?? resolveShimPath();
    const argv = [
      process.execPath,
      shimPath,
      "--sprite",
      this.spriteName,
      "--cwd",
      remoteWorkdir,
      ...(execParams.usePty ? ["--tty"] : []),
      "--",
      "/bin/sh",
      remoteScript,
    ];
    const shimEnv: NodeJS.ProcessEnv = {
      ...sanitizeEnvVars(process.env).allowed,
      OPENCLAW_SPRITES_TOKEN: this.params.token,
      OPENCLAW_SPRITES_API_URL: pluginConfig.apiUrl,
      OPENCLAW_SPRITES_WAKE_TIMEOUT_MS: String(pluginConfig.wake.timeoutMs),
      OPENCLAW_SPRITES_WAKE_MAX_RETRY_MS: String(pluginConfig.wake.maxRetryDelayMs),
      OPENCLAW_SPRITES_MAX_RUN_AFTER_DISCONNECT: pluginConfig.sandbox.maxRunAfterDisconnect,
    };
    this.touch();
    return { argv, env: shimEnv, stdinMode: "pipe-open", finalizeToken: { remoteDir } };
  }

  async finalizeExec(status: "completed" | "failed", token?: PendingExec): Promise<void> {
    this.touch();
    if (!token || status === "completed") {
      // The staged script removes its own directory as its first step, so a
      // completed run left nothing behind and no extra round trip is needed.
      return;
    }
    // Best effort cleanup for a shim that never launched; never blocks the tool result.
    await this.runRemoteShellScript({
      script: 'rm -rf -- "$1"',
      args: [token.remoteDir],
      allowFailure: true,
    }).catch(() => undefined);
  }

  // -------------------------------------------------------------- shell + workdir

  async runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult> {
    await this.ensureRuntime();
    await this.ensureSkillsCurrent();
    return await this.runRemoteShellScriptRaw(params);
  }

  private async runRemoteShellScriptRaw(
    params: StreamingCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    this.touch();
    const result = await this.params.client.exec(this.spriteName, {
      argv: ["/bin/sh", "-c", params.script, "openclaw-sandbox", ...(params.args ?? [])],
      stdin: params.stdin,
      signal: params.signal,
      maxRunAfterDisconnect: this.params.deps.pluginConfig.sandbox.maxRunAfterDisconnect,
    });
    if (result.code !== 0 && !params.allowFailure) {
      const detail = result.stderr.toString("utf8").trim() || `exit ${result.code}`;
      throw new Error(`Sprite command failed: ${detail}`);
    }
    return result;
  }

  async validateWorkdir(workdir: string): Promise<string | null> {
    await this.ensureRuntime();
    await this.ensureSkillsCurrent();
    const root = isInside(this.remoteAgentWorkspaceDir, workdir)
      ? this.remoteAgentWorkspaceDir
      : this.remoteWorkspaceDir;
    const result = await this.runRemoteShellScriptRaw({
      script: buildRemoteWorkdirValidationCommand({ workdir, root }),
      allowFailure: true,
    });
    if (result.code !== 0) {
      return null;
    }
    return result.stdout.toString("utf8").trim() || null;
  }

  // -------------------------------------------------------------- lifecycle

  private async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<void> {
    const { deps, client, createParams } = this.params;
    const { pluginConfig, logger } = deps;
    let sprite = await client.getSprite(this.spriteName);
    let created = false;
    if (!sprite) {
      logger.info(`sprites: creating sprite ${this.spriteName} for scope ${createParams.scopeKey}`);
      sprite = await client.createSprite({
        name: this.spriteName,
        labels: buildSpriteLabels(pluginConfig, this.params.instanceId, createParams.scopeKey),
        runtime: pluginConfig.sandbox.runtime,
        config: pluginConfig.sandbox.sprite,
        waitForCapacity: true,
      });
      created = true;
    } else if (!isOwnedSprite(sprite.labels, this.params.instanceId)) {
      throw new Error(
        `Sprite ${this.spriteName} already exists but is not owned by this Gateway instance. ` +
          "Choose a different plugins.entries.sprites.config.namePrefix or delete the sprite.",
      );
    } else if (actualConfigLabel(sprite.labels) !== configLabel(pluginConfig)) {
      throw new Error(
        `Sprite ${this.spriteName} was initialized with a different sandbox configuration. ` +
          "Recreate it with `openclaw sandbox recreate` before running tools.",
      );
    } else {
      const status = parseSpriteStatus(sprite.status);
      if (status !== "running") {
        logger.info(`sprites: sprite ${this.spriteName} is ${describeSpriteStatus(status)}; it will wake on first use`);
      }
    }

    // The marker is written only after seeding and setup succeed, so a failed
    // bootstrap is retried from scratch instead of being mistaken for a ready sprite.
    const marker = readyMarkerPath(this.remoteWorkspaceDir);
    const probe = await this.runRemoteShellScriptRaw({
      script: 'if [ -f "$1" ]; then cat -- "$1"; fi',
      args: [marker],
    });
    const markerValue = probe.stdout.toString("utf8").trim();
    if (markerValue) {
      if (markerValue === this.readyMarkerValue && !created) {
        return;
      }
      throw new Error(
        `Sprite ${this.spriteName} was initialized with a different sandbox configuration. ` +
          "Recreate it with `openclaw sandbox recreate` before running tools.",
      );
    }

    // Reapply on every incomplete bootstrap. This closes the fail-open window
    // where sprite creation succeeded but a policy request transiently failed.
    await this.applyPolicies();
    await this.seedWorkspace();
    await this.runSetupCommand();
    await this.writeReadyMarker(marker);
    if (pluginConfig.sandbox.checkpointAfterSetup) {
      logger.info(`sprites: checkpointing ${this.spriteName} after setup`);
      try {
        await client.createCheckpoint(this.spriteName, SETUP_CHECKPOINT_COMMENT);
      } catch (error) {
        await this.removeReadyMarker(marker);
        throw error;
      }
    }
    logger.info(`sprites: sprite ${this.spriteName} is ready (workspace ${this.remoteWorkspaceDir})`);
  }

  private async writeReadyMarker(marker: string): Promise<void> {
    await this.runRemoteShellScriptRaw({
      script: 'mkdir -p -- "$(dirname -- "$1")" && printf "%s\\n" "$2" > "$1"',
      args: [marker, this.readyMarkerValue],
    });
  }

  private async removeReadyMarker(marker: string): Promise<void> {
    await this.runRemoteShellScriptRaw({
      script: 'rm -f -- "$1"',
      args: [marker],
      allowFailure: true,
    }).catch(() => undefined);
  }

  private async applyPolicies(): Promise<void> {
    const { pluginConfig, logger } = this.params.deps;
    if (pluginConfig.sandbox.network) {
      logger.info(`sprites: applying network policy to ${this.spriteName}`);
      await this.params.client.setNetworkPolicy(this.spriteName, pluginConfig.sandbox.network);
    }
    if (pluginConfig.sandbox.privileges) {
      await this.params.client.setPrivilegesPolicy(this.spriteName, pluginConfig.sandbox.privileges);
    }
  }

  private async seedWorkspace(): Promise<void> {
    const { createParams } = this.params;
    await this.uploadDirectory(createParams.workspaceDir, this.remoteWorkspaceDir);
    const agentDir = path.resolve(createParams.agentWorkspaceDir);
    if (createParams.cfg.workspaceAccess !== "none" && agentDir !== path.resolve(createParams.workspaceDir)) {
      await this.uploadDirectory(createParams.agentWorkspaceDir, this.remoteAgentWorkspaceDir);
    }
    if (createParams.skillsWorkspaceDir) {
      await this.uploadDirectory(
        createParams.skillsWorkspaceDir,
        path.posix.join(this.remoteWorkspaceDir, ".openclaw", "sandbox-skills"),
      );
      this.skillsRefreshPromise = Promise.resolve();
    }
  }

  private async ensureSkillsCurrent(): Promise<void> {
    const { createParams } = this.params;
    if (!createParams.skillsWorkspaceDir || createParams.cfg.workspaceAccess !== "rw") {
      return;
    }
    this.skillsRefreshPromise ??= this.uploadDirectory(
      createParams.skillsWorkspaceDir,
      path.posix.join(this.remoteWorkspaceDir, ".openclaw", "sandbox-skills"),
    ).catch((error: unknown) => {
      this.skillsRefreshPromise = null;
      throw error;
    });
    await this.skillsRefreshPromise;
  }

  private async uploadDirectory(localDir: string, remoteDir: string): Promise<void> {
    const exists = await fs.stat(localDir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) {
      await this.runRemoteShellScriptRaw({
        script: 'rm -rf -- "$1"; mkdir -p -- "$1"',
        args: [remoteDir],
      });
      return;
    }
    await streamTarDirectory(localDir, async (archive) => {
      await this.runRemoteShellScriptRaw({
        script: 'set -e; rm -rf -- "$1"; mkdir -p -- "$1"; tar -xf - -C "$1"',
        args: [remoteDir],
        stdin: archive,
      });
    });
  }

  private async runSetupCommand(): Promise<void> {
    const setupCommand = this.params.createParams.cfg.docker.setupCommand?.trim();
    if (!setupCommand) {
      return;
    }
    this.params.deps.logger.info(`sprites: running setupCommand in ${this.spriteName}`);
    const envExports = buildEnvExports(this.params.createParams.cfg.docker.env ?? {});
    const result = await this.runRemoteShellScriptRaw({
      script: ["set -e", ...envExports, 'cd -- "$1"', 'exec sh -lc "$2"'].join("\n"),
      args: [this.remoteWorkspaceDir, setupCommand],
      allowFailure: true,
    });
    if (result.code !== 0) {
      throw new Error(
        `sandbox.docker.setupCommand failed in sprite ${this.spriteName} (exit ${result.code}): ` +
          result.stderr.toString("utf8").trim().slice(0, 2000),
      );
    }
  }

  // -------------------------------------------------------------- keep-awake

  private touch(): void {
    this.lastActivityAt = Date.now();
    const minutes = this.params.deps.pluginConfig.wake.keepAwakeMinutes;
    if (minutes <= 0 || this.keepAwakeTimer) {
      return;
    }
    this.keepAwakeTimer = setInterval(() => {
      void this.keepAwakeTick();
    }, KEEP_AWAKE_TICK_MS);
    this.keepAwakeTimer.unref();
  }

  private async keepAwakeTick(): Promise<void> {
    const minutes = this.params.deps.pluginConfig.wake.keepAwakeMinutes;
    if (Date.now() - this.lastActivityAt > minutes * 60 * 1000) {
      this.stopKeepAwake();
      this.params.deps.logger.info(
        `sprites: keep-awake window for ${this.spriteName} ended; it may sleep until the next tool call`,
      );
      return;
    }
    try {
      await this.params.client.exec(this.spriteName, { argv: ["true"] });
    } catch (error) {
      this.params.deps.logger.warn(
        `sprites: keep-awake ping for ${this.spriteName} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stopKeepAwake(): void {
    if (this.keepAwakeTimer) {
      clearInterval(this.keepAwakeTimer);
      this.keepAwakeTimer = null;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  const normalizedTarget = path.posix.normalize(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function buildEnvExports(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid sandbox environment variable name ${JSON.stringify(key)}`);
    }
    if (value.includes("\0")) {
      throw new Error(`Invalid sandbox environment variable ${JSON.stringify(key)}: NUL byte`);
    }
    return `export ${key}=${shellEscape(value)}`;
  });
}

/** Streams a tar archive of `dir` (contents, not the directory itself). */
export async function streamTarDirectory<T>(
  dir: string,
  consume: (archive: AsyncIterable<Uint8Array>) => Promise<T>,
): Promise<T> {
  const child = spawn("tar", ["-cf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "pipe"] });
  const relay = new PassThrough();
  child.stdout.pipe(relay);
  const errors: Buffer[] = [];
  let errorBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes < 64 * 1024) {
      errors.push(chunk.subarray(0, 64 * 1024 - errorBytes));
      errorBytes += chunk.length;
    }
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar failed (exit ${code}): ${Buffer.concat(errors).toString("utf8").trim()}`));
      }
    });
  });
  try {
    const [result] = await Promise.all([consume(relay), completed]);
    return result;
  } catch (error) {
    child.kill("SIGKILL");
    relay.destroy();
    await completed.catch(() => undefined);
    throw error;
  }
}

export type { SandboxRegistryEntry };

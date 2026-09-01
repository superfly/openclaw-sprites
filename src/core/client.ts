/**
 * Wake-aware wrapper around the `@fly/sprites` SDK.
 *
 * The SDK covers the control plane, exec, policies, and checkpoints. What it
 * cannot do is see the HTTP 503 that a sleeping sprite returns on a WebSocket
 * handshake (the WHATWG WebSocket API hides handshake responses). So every
 * in-sprite operation here goes through `ensureAwake` first: a cheap HTTP
 * request that either succeeds, or reports `sprite_starting`, which `withWake`
 * retries within a bounded budget while telling the observer what is going on.
 */
import {
  APIError,
  SpritesClient,
  type Sprite,
  type SpriteCommand,
  type SpawnOptions,
} from "@fly/sprites";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseSpriteStatus, type SpriteInfo, type SpriteStatus } from "./protocol.js";
import {
  DEFAULT_WAKE_SETTINGS,
  SpriteStartingSignal,
  detectSpriteStarting,
  withWake,
  type WakeObserver,
  type WakeSettings,
} from "./wake.js";

export type SpritesGatewayOptions = {
  token: string;
  apiUrl?: string;
  wake?: Partial<WakeSettings>;
  onWake?: WakeObserver;
  requestTimeoutMs?: number;
  /** Overridable for tests. */
  fetch?: typeof fetch;
  sdk?: SpritesClient;
};

export type CreateSpriteParams = {
  name: string;
  labels?: string[];
  runtime?: "default" | "dev";
  config?: { ramMB?: number; cpus?: number; region?: string; storageGB?: number };
  waitForCapacity?: boolean;
};

export type NetworkPolicyRule = { domain?: string; action?: "allow" | "deny"; include?: string };
export type NetworkPolicy = { rules: NetworkPolicyRule[] };
export type PrivilegesPolicy = {
  profile?: "" | "minimal" | "standard" | "privileged";
  devices?: string[];
  noNewPrivileges?: boolean;
};

export type ExecResult = { stdout: Buffer; stderr: Buffer; code: number };

export type ExecParams = {
  /** argv; the first entry is the program. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Buffer | string | AsyncIterable<Uint8Array | string>;
  maxRunAfterDisconnect?: string;
  signal?: AbortSignal;
  maxBufferBytes?: number;
};

export type CheckpointSummary = { id: string; comment?: string; createTime?: Date };

export class SpritesGateway {
  readonly apiUrl: string;
  readonly wakeSettings: WakeSettings;
  readonly sdk: SpritesClient;
  private readonly token: string;
  private readonly onWake?: WakeObserver;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Sprites confirmed awake recently; avoids a probe per file operation. */
  private readonly awakeUntil = new Map<string, number>();

  constructor(options: SpritesGatewayOptions) {
    this.token = options.token;
    this.apiUrl = normalizeApiUrl(options.apiUrl ?? "https://api.sprites.dev");
    this.wakeSettings = { ...DEFAULT_WAKE_SETTINGS, ...stripUndefined(options.wake ?? {}) };
    this.onWake = options.onWake;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sdk =
      options.sdk ??
      new SpritesClient(options.token, { baseURL: this.apiUrl, timeout: this.requestTimeoutMs });
  }

  // ---------------------------------------------------------------- control plane

  async getSprite(name: string): Promise<SpriteInfo | null> {
    try {
      return toInfo(await this.sdk.getSprite(name));
    } catch (error) {
      if (error instanceof APIError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async getSpriteStatus(name: string): Promise<SpriteStatus | "missing"> {
    const sprite = await this.getSprite(name);
    return sprite ? parseSpriteStatus(sprite.status) : "missing";
  }

  async createSprite(params: CreateSpriteParams): Promise<SpriteInfo> {
    const sprite = await this.sdk.createSprite(params.name, {
      config: params.config,
      labels: params.labels,
      runtime: params.runtime,
      waitForCapacity: params.waitForCapacity,
    });
    return toInfo(sprite);
  }

  async deleteSprite(name: string): Promise<void> {
    try {
      await this.sdk.deleteSprite(name);
    } catch (error) {
      if (error instanceof APIError && error.statusCode === 404) {
        return;
      }
      throw error;
    } finally {
      this.awakeUntil.delete(name);
    }
  }

  async listSprites(prefix: string): Promise<SpriteInfo[]> {
    return (await this.sdk.listAllSprites(prefix || undefined)).map(toInfo);
  }

  // ---------------------------------------------------------------- sleep / wake

  /**
   * Resolves once the sprite answers an in-sprite HTTP request. A sleeping
   * sprite is resumed by that request; `withWake` retries until it is up.
   */
  async ensureAwake(name: string, signal?: AbortSignal): Promise<void> {
    if ((this.awakeUntil.get(name) ?? 0) > Date.now()) {
      return;
    }
    await withWake({
      spriteName: name,
      settings: this.wakeSettings,
      observer: this.onWake,
      signal,
      operation: () => this.probe(name),
    });
    // A sprite suspends after ~10 idle minutes; trust the probe for a short window.
    this.awakeUntil.set(name, Date.now() + 30_000);
  }

  private async probe(name: string): Promise<void> {
    const path = `/v1/sprites/${encodeURIComponent(name)}/exec`;
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (res.ok) {
      await res.arrayBuffer();
      return;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const starting = detectSpriteStarting(res.status, body);
    if (starting) {
      throw new SpriteStartingSignal(name, starting);
    }
    throw new Error(`Sprite ${name} probe failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  /** Forget the cached awake state, e.g. after a failed exec. */
  forgetAwake(name: string): void {
    this.awakeUntil.delete(name);
  }

  // ---------------------------------------------------------------- exec

  /** Opens a streaming exec session. Call `ensureAwake` first. */
  spawn(name: string, program: string, args: string[], options: SpawnOptions): SpriteCommand {
    return this.sdk.sprite(name).spawn(program, args, options);
  }

  /** Runs a command to completion and buffers output; never throws on non-zero exit. */
  async exec(name: string, params: ExecParams): Promise<ExecResult> {
    await this.ensureAwake(name, params.signal);
    const [program, ...args] = params.argv;
    if (!program) {
      throw new Error("exec requires a program");
    }
    const maxBuffer = params.maxBufferBytes ?? 64 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let buffered = 0;
    try {
      return await new Promise<ExecResult>((resolve, reject) => {
        const cmd = this.spawn(name, program, args, {
          cwd: params.cwd,
          env: params.env,
          maxRunAfterDisconnect: params.maxRunAfterDisconnect ?? "10s",
        });
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          params.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => {
          try {
            cmd.kill("SIGKILL");
          } catch {
            // ignore
          }
          settle(() => reject(params.signal?.reason ?? new Error("Aborted")));
        };
        if (params.signal?.aborted) {
          onAbort();
          return;
        }
        params.signal?.addEventListener("abort", onAbort, { once: true });

        const collect = (target: Buffer[]) => (chunk: Buffer) => {
          buffered += chunk.length;
          if (buffered > maxBuffer) {
            try {
              cmd.kill("SIGKILL");
            } catch {
              // ignore
            }
            settle(() => reject(new Error(`Sprite exec output exceeded ${maxBuffer} bytes`)));
            return;
          }
          target.push(chunk);
        };
        cmd.stdout.on("data", collect(stdout));
        cmd.stderr.on("data", collect(stderr));
        cmd.on("error", (error: Error) => settle(() => reject(error)));
        cmd.on("exit", (code: number) =>
          settle(() =>
            resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code < 0 ? 1 : code }),
          ),
        );
        cmd.once("spawn", () => {
          if (params.stdin === undefined) {
            cmd.stdin.end();
            return;
          }
          if (typeof params.stdin === "string" || Buffer.isBuffer(params.stdin)) {
            cmd.stdin.end(params.stdin);
            return;
          }
          void pipeline(Readable.from(params.stdin), cmd.stdin).catch((error: unknown) => {
            try {
              cmd.kill("SIGKILL");
            } catch {
              // ignore
            }
            settle(() => reject(error));
          });
        });
      });
    } catch (error) {
      this.forgetAwake(name);
      throw error;
    }
  }

  async killSession(name: string, sessionId: string, signal = "SIGKILL"): Promise<void> {
    const stream = await this.sdk.sprite(name).killSession(sessionId, signal, "5s");
    await stream.processAll(() => undefined);
  }

  // ---------------------------------------------------------------- policies + checkpoints

  async setNetworkPolicy(name: string, policy: NetworkPolicy): Promise<void> {
    await this.ensureAwake(name);
    await this.sdk.sprite(name).updateNetworkPolicy(policy);
  }

  async setPrivilegesPolicy(name: string, policy: PrivilegesPolicy): Promise<void> {
    await this.ensureAwake(name);
    await this.sdk.sprite(name).updatePrivilegesPolicy(policy);
  }

  async createCheckpoint(name: string, comment: string): Promise<string | undefined> {
    await this.ensureAwake(name);
    const stream = await this.sdk.sprite(name).createCheckpoint(comment);
    let failure: string | undefined;
    await stream.processAll((msg) => {
      if (msg.type === "error") {
        failure = msg.error ?? msg.data ?? "checkpoint failed";
      }
    });
    if (failure) {
      throw new Error(`Checkpoint of ${name} failed: ${failure}`);
    }
    const created = (await this.listCheckpoints(name))
      .filter((c) => c.comment === comment)
      .sort((a, b) => (b.createTime?.getTime() ?? 0) - (a.createTime?.getTime() ?? 0))[0];
    return created?.id;
  }

  async listCheckpoints(name: string): Promise<CheckpointSummary[]> {
    await this.ensureAwake(name);
    return (await this.sdk.sprite(name).listCheckpoints()).map((c) => ({
      id: c.id,
      comment: c.comment,
      createTime: c.createTime,
    }));
  }

  async restoreCheckpoint(name: string, checkpointId: string): Promise<void> {
    await this.ensureAwake(name);
    const stream = await this.sdk.sprite(name).restoreCheckpoint(checkpointId);
    let failure: string | undefined;
    await stream.processAll((msg) => {
      if (msg.type === "error") {
        failure = msg.error ?? msg.data ?? "restore failed";
      }
    });
    if (failure) {
      throw new Error(`Restore of ${name} to ${checkpointId} failed: ${failure}`);
    }
    this.forgetAwake(name);
  }
}

function toInfo(sprite: Sprite): SpriteInfo {
  return {
    id: sprite.id ?? "",
    name: sprite.name,
    organization: sprite.organizationName,
    status: parseSpriteStatus(sprite.status),
    url: sprite.url,
    labels: sprite.labels ?? [],
    created_at: sprite.createdAt?.toISOString(),
    updated_at: sprite.updatedAt?.toISOString(),
    last_running_at: sprite.lastRunningAt?.toISOString() ?? null,
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Sprites apiUrl must be an absolute URL, got ${JSON.stringify(raw)}`);
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Sprites apiUrl must use https (http is allowed only for loopback hosts)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Sprites apiUrl must not contain credentials, a query, or a fragment");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

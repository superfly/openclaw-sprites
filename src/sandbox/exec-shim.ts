#!/usr/bin/env node
/**
 * Exec shim: the local process OpenClaw spawns for every sandboxed `exec`.
 *
 * It bridges the Gateway's stdio to one Sprites exec session through the
 * `@fly/sprites` SDK. Before opening the session it makes sure the sprite is
 * awake, using the same bounded wake retry as the rest of the plugin, so a
 * suspended sprite never surfaces as an opaque WebSocket failure.
 *
 * SIGTERM/SIGINT/SIGHUP from the Gateway (tool timeout, abort, shutdown)
 * signal the remote process and kill its session before exiting.
 *
 * Configuration arrives through the environment so no secret appears in argv:
 *   OPENCLAW_SPRITES_TOKEN, OPENCLAW_SPRITES_API_URL,
 *   OPENCLAW_SPRITES_WAKE_TIMEOUT_MS, OPENCLAW_SPRITES_WAKE_MAX_RETRY_MS,
 *   OPENCLAW_SPRITES_MAX_RUN_AFTER_DISCONNECT, OPENCLAW_SPRITES_SHIM_VERBOSE
 *
 * Usage: exec-shim --sprite <name> [--cwd <dir>] [--tty] -- <program> [args...]
 */
import { SpritesGateway } from "../core/client.js";
import type { WakeEvent } from "../core/wake.js";

export type ShimArgs = { sprite: string; cwd?: string; tty: boolean; argv: string[] };

export function parseShimArgs(args: string[]): ShimArgs {
  let sprite: string | undefined;
  let cwd: string | undefined;
  let tty = false;
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "--sprite") {
      sprite = args[++i];
    } else if (arg === "--cwd") {
      cwd = args[++i];
    } else if (arg === "--tty") {
      tty = true;
    } else {
      throw new Error(`Unknown shim argument: ${arg}`);
    }
  }
  const argv = args.slice(i);
  if (!sprite) {
    throw new Error("--sprite is required");
  }
  if (argv.length === 0) {
    throw new Error("a program is required after --");
  }
  return { sprite, cwd, tty, argv };
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function runShim(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseShimArgs(args);
  const token = env.OPENCLAW_SPRITES_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_SPRITES_TOKEN is not set");
  }
  const verbose = env.OPENCLAW_SPRITES_SHIM_VERBOSE === "1";
  const note = (message: string) => {
    if (verbose) {
      process.stderr.write(`[sprites] ${message}\n`);
    }
  };
  const gateway = new SpritesGateway({
    token,
    apiUrl: env.OPENCLAW_SPRITES_API_URL,
    wake: {
      timeoutMs: envNumber("OPENCLAW_SPRITES_WAKE_TIMEOUT_MS"),
      maxRetryDelayMs: envNumber("OPENCLAW_SPRITES_WAKE_MAX_RETRY_MS"),
    },
    onWake: (event: WakeEvent) => {
      if (event.type === "waking" && event.attempt === 1) {
        note(`sprite ${event.spriteName} is asleep; waking it`);
      } else if (event.type === "awake") {
        note(`sprite ${event.spriteName} awake after ${(event.waitedMs / 1000).toFixed(1)}s`);
      }
    },
  });

  // Wake first: the SDK's WebSocket cannot see the 503 a sleeping sprite returns.
  await gateway.ensureAwake(parsed.sprite);

  const [program, ...programArgs] = parsed.argv as [string, ...string[]];
  const cmd = gateway.spawn(parsed.sprite, program, programArgs, {
    cwd: parsed.cwd,
    tty: parsed.tty,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    maxRunAfterDisconnect: env.OPENCLAW_SPRITES_MAX_RUN_AFTER_DISCONNECT ?? "10s",
  });

  return await new Promise<number>((resolve) => {
    let finished = false;
    let sessionId: string | undefined;
    const finish = (code: number) => {
      if (!finished) {
        finished = true;
        resolve(code);
      }
    };

    cmd.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    cmd.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    cmd.on("message", (msg: { type?: string; session_id?: string; id?: string }) => {
      if (msg && typeof msg === "object" && msg.type === "session_info") {
        sessionId = msg.session_id ?? msg.id ?? sessionId;
      }
    });
    cmd.on("exit", (code: number) => finish(code < 0 ? 1 : code));
    cmd.on("error", (error: Error) => {
      process.stderr.write(`[sprites] exec failed: ${error.message}\n`);
      finish(1);
    });

    // The session is not writable until the socket is open; queue stdin until then.
    let open = false;
    let pendingEnd = false;
    const pending: Buffer[] = [];
    const flush = () => {
      for (const chunk of pending.splice(0)) {
        cmd.stdin.write(chunk);
      }
      if (pendingEnd) {
        cmd.stdin.end();
      }
    };
    cmd.once("spawn", () => {
      open = true;
      flush();
    });
    process.stdin.on("data", (chunk: Buffer) => {
      if (open) {
        cmd.stdin.write(chunk);
      } else {
        pending.push(chunk);
      }
    });
    process.stdin.on("end", () => {
      if (open) {
        cmd.stdin.end();
      } else {
        pendingEnd = true;
      }
    });
    process.stdin.on("error", () => undefined);
    process.stdin.resume();

    if (parsed.tty && process.stdout.isTTY) {
      process.stdout.on("resize", () => {
        cmd.resize(process.stdout.columns, process.stdout.rows);
      });
    }

    const onSignal = (signal: NodeJS.Signals) => {
      note(`received ${signal}; stopping remote command`);
      try {
        cmd.kill("SIGKILL");
      } catch {
        // socket may already be closed
      }
      const kill = sessionId
        ? gateway.killSession(parsed.sprite, sessionId).catch(() => undefined)
        : Promise.resolve();
      void kill.finally(() => finish(signal === "SIGINT" ? 130 : 143));
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    process.once("SIGHUP", onSignal);
  });
}

const isDirectRun =
  typeof process.argv[1] === "string" && /exec-shim\.(?:js|mjs|cjs)$/.test(process.argv[1]);
if (isDirectRun) {
  runShim(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      // Give stdout a moment to flush before exiting.
      setTimeout(() => process.exit(code), 10);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[sprites] ${message}\n`);
      process.exit(1);
    });
}

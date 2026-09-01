/**
 * Sleep/wake handling for sprites.
 *
 * A sprite suspends itself after roughly ten idle minutes. The first request
 * after that is answered by the control plane with HTTP 503 and an
 * `sprite_starting` body until the microVM is back. This module turns that
 * into one explicit, observable step: every request path calls `withWake`,
 * which retries within a bounded budget and reports what happened so the
 * plugin can log "waking sprite X" once instead of surfacing raw 503s.
 */
import { isSpriteStartingBody, type SpriteStartingError } from "./protocol.js";

export type WakeSettings = {
  /** Total time to keep retrying while the sprite reports `sprite_starting`. */
  timeoutMs: number;
  /** Upper bound on one retry pause, regardless of the server's hint. */
  maxRetryDelayMs: number;
};

export const DEFAULT_WAKE_SETTINGS: WakeSettings = {
  timeoutMs: 120_000,
  maxRetryDelayMs: 5_000,
};

export type WakeEvent =
  | { type: "waking"; spriteName: string; attempt: number; retryAfterMs: number }
  | { type: "awake"; spriteName: string; waitedMs: number; attempts: number }
  | { type: "timeout"; spriteName: string; waitedMs: number; attempts: number };

export type WakeObserver = (event: WakeEvent) => void;

/** Thrown when a request kept returning `sprite_starting` past the wake budget. */
export class SpriteWakeTimeoutError extends Error {
  constructor(
    readonly spriteName: string,
    readonly waitedMs: number,
    readonly attempts: number,
  ) {
    super(
      `Sprite "${spriteName}" did not wake within ${Math.round(waitedMs / 1000)}s ` +
        `(${attempts} attempts). Raise plugins.entries.sprites.config.wake.timeoutSeconds ` +
        `or check the sprite with \`openclaw sprites status\`.`,
    );
    this.name = "SpriteWakeTimeoutError";
  }
}

/** Signals that the wrapped operation hit a `sprite_starting` response. */
export class SpriteStartingSignal extends Error {
  constructor(
    readonly spriteName: string,
    readonly body: SpriteStartingError | undefined,
  ) {
    super(`Sprite "${spriteName}" is starting`);
    this.name = "SpriteStartingSignal";
  }
}

export function isSpriteStartingSignal(error: unknown): error is SpriteStartingSignal {
  return error instanceof SpriteStartingSignal;
}

/**
 * Interprets an HTTP status and parsed body. Returns the starting body when the
 * response means "retry, the sprite is resuming", otherwise undefined.
 */
export function detectSpriteStarting(
  status: number,
  body: unknown,
): SpriteStartingError | undefined {
  if (status === 503 && isSpriteStartingBody(body)) {
    return body;
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `operation`, retrying while it throws `SpriteStartingSignal`, until the
 * wake budget is spent. Emits observer events so callers can log the wake once.
 */
export async function withWake<T>(params: {
  spriteName: string;
  settings: WakeSettings;
  operation: () => Promise<T>;
  observer?: WakeObserver;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T> {
  const now = params.now ?? Date.now;
  const pause = params.sleep ?? sleep;
  const startedAt = now();
  let attempts = 0;
  let announced = false;
  for (;;) {
    attempts += 1;
    try {
      const result = await params.operation();
      if (announced) {
        params.observer?.({
          type: "awake",
          spriteName: params.spriteName,
          waitedMs: now() - startedAt,
          attempts,
        });
      }
      return result;
    } catch (error) {
      if (!isSpriteStartingSignal(error)) {
        throw error;
      }
      const waitedMs = now() - startedAt;
      const hintedMs = (error.body?.retry_after_seconds ?? 5) * 1000;
      const retryAfterMs = Math.max(250, Math.min(hintedMs, params.settings.maxRetryDelayMs));
      if (waitedMs + retryAfterMs > params.settings.timeoutMs) {
        params.observer?.({
          type: "timeout",
          spriteName: params.spriteName,
          waitedMs,
          attempts,
        });
        throw new SpriteWakeTimeoutError(params.spriteName, waitedMs, attempts);
      }
      if (!announced) {
        announced = true;
      }
      params.observer?.({
        type: "waking",
        spriteName: params.spriteName,
        attempt: attempts,
        retryAfterMs,
      });
      await pause(retryAfterMs, params.signal);
    }
  }
}

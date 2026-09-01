import { describe, expect, it } from "vitest";
import {
  SpriteStartingSignal,
  SpriteWakeTimeoutError,
  detectSpriteStarting,
  withWake,
  type WakeEvent,
} from "./wake.js";

describe("detectSpriteStarting", () => {
  it("recognizes the control plane's 503 body", () => {
    expect(detectSpriteStarting(503, { error: "sprite_starting", retry_after_seconds: 5 })).toEqual({
      error: "sprite_starting",
      retry_after_seconds: 5,
    });
  });
  it("ignores other 503s and other statuses", () => {
    expect(detectSpriteStarting(503, { error: "overloaded" })).toBeUndefined();
    expect(detectSpriteStarting(200, { error: "sprite_starting" })).toBeUndefined();
    expect(detectSpriteStarting(503, "not json")).toBeUndefined();
  });
});

describe("withWake", () => {
  const settings = { timeoutMs: 10_000, maxRetryDelayMs: 500 };

  it("returns immediately when the sprite is awake and emits nothing", async () => {
    const events: WakeEvent[] = [];
    const result = await withWake({
      spriteName: "s",
      settings,
      observer: (e) => events.push(e),
      operation: async () => "ok",
    });
    expect(result).toBe("ok");
    expect(events).toEqual([]);
  });

  it("retries while the sprite is starting and reports waking then awake", async () => {
    const events: WakeEvent[] = [];
    let clock = 0;
    let calls = 0;
    const result = await withWake({
      spriteName: "s",
      settings,
      observer: (e) => events.push(e),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      operation: async () => {
        calls += 1;
        if (calls < 3) {
          throw new SpriteStartingSignal("s", { error: "sprite_starting", retry_after_seconds: 5 });
        }
        return "up";
      },
    });
    expect(result).toBe("up");
    expect(calls).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["waking", "waking", "awake"]);
    // retry_after 5s is clamped to maxRetryDelayMs
    expect((events[0] as Extract<WakeEvent, { type: "waking" }>).retryAfterMs).toBe(500);
    expect((events[2] as Extract<WakeEvent, { type: "awake" }>).waitedMs).toBe(1000);
  });

  it("gives up with a clear error when the budget is spent", async () => {
    const events: WakeEvent[] = [];
    let clock = 0;
    await expect(
      withWake({
        spriteName: "sleepy",
        settings: { timeoutMs: 1200, maxRetryDelayMs: 500 },
        observer: (e) => events.push(e),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        operation: async () => {
          throw new SpriteStartingSignal("sleepy", { error: "sprite_starting" });
        },
      }),
    ).rejects.toBeInstanceOf(SpriteWakeTimeoutError);
    expect(events.at(-1)?.type).toBe("timeout");
    const error = await withWake({
      spriteName: "sleepy",
      settings: { timeoutMs: 100, maxRetryDelayMs: 500 },
      operation: async () => {
        throw new SpriteStartingSignal("sleepy", undefined);
      },
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(SpriteWakeTimeoutError);
    expect(error.message).toContain("wake.timeoutSeconds");
    expect(error.message).toContain("openclaw sprites status");
  });

  it("does not swallow unrelated errors", async () => {
    await expect(
      withWake({
        spriteName: "s",
        settings,
        operation: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });
});

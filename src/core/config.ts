/**
 * Settings shared by every capability of the plugin: how to reach Sprites and
 * how to handle sleeping sprites. Capability-specific settings live in their
 * own namespace (for example `sandbox`), see `src/config.ts`.
 */
import { z } from "zod";
import { DEFAULT_WAKE_SETTINGS, type WakeSettings } from "./wake.js";

export const DEFAULT_API_URL = "https://api.sprites.dev";
export const DEFAULT_TIMEOUT_MS = 120_000;

export type ResolvedSpritesCoreConfig = {
  /** Raw token config value (string or SecretRef object); resolved lazily. */
  token: unknown;
  apiUrl: string;
  timeoutMs: number;
  wake: WakeSettings & { keepAwakeMinutes: number };
};

export const SpritesCoreConfigSchema = z.strictObject({
  token: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
  apiUrl: z.string().trim().min(1).optional(),
  timeoutSeconds: z.number().min(1).max(3600).optional(),
  wake: z
    .strictObject({
      timeoutSeconds: z.number().min(5).max(1800).optional(),
      maxRetrySeconds: z.number().min(0.25).max(60).optional(),
      keepAwakeMinutes: z.number().min(0).max(240).optional(),
    })
    .optional(),
});

export type SpritesCoreConfigInput = z.infer<typeof SpritesCoreConfigSchema>;

export function resolveSpritesCoreConfig(input: SpritesCoreConfigInput): ResolvedSpritesCoreConfig {
  return {
    token: input.token,
    apiUrl: input.apiUrl ?? DEFAULT_API_URL,
    timeoutMs: Math.round((input.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000),
    wake: {
      timeoutMs: Math.round((input.wake?.timeoutSeconds ?? DEFAULT_WAKE_SETTINGS.timeoutMs / 1000) * 1000),
      maxRetryDelayMs: Math.round(
        (input.wake?.maxRetrySeconds ?? DEFAULT_WAKE_SETTINGS.maxRetryDelayMs / 1000) * 1000,
      ),
      keepAwakeMinutes: input.wake?.keepAwakeMinutes ?? 0,
    },
  };
}

export const SPRITES_CORE_UI_HINTS: Record<string, { label: string; help: string; advanced?: boolean }> = {
  token: {
    label: "Sprites token",
    help: "Sprites API token (string or SecretRef). Falls back to the SPRITES_TOKEN environment variable.",
  },
  apiUrl: { label: "API URL", help: "Sprites control plane. Default https://api.sprites.dev.", advanced: true },
  timeoutSeconds: { label: "Request timeout", help: "Timeout for control-plane requests.", advanced: true },
  wake: {
    label: "Sleep and wake",
    help: "timeoutSeconds: how long to wait for a suspended sprite to resume (default 120). keepAwakeMinutes: keep a sprite awake this long after its last use (default 0 = let it sleep).",
  },
};

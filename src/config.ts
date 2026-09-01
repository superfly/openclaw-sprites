/**
 * Plugin configuration: `plugins.entries.sprites.config`.
 *
 * Shared settings (token, API URL, sleep/wake) sit at the top level; each
 * capability owns a namespace beneath them. Today that is `sandbox`.
 */
import {
  SPRITES_CORE_UI_HINTS,
  SpritesCoreConfigSchema,
  resolveSpritesCoreConfig,
  type ResolvedSpritesCoreConfig,
} from "./core/config.js";
import {
  SPRITES_SANDBOX_UI_HINTS,
  SpritesSandboxConfigSchema,
  resolveSpritesSandboxConfig,
  type ResolvedSpritesSandboxConfig,
} from "./sandbox/config.js";

export type { ResolvedSpritesCoreConfig, ResolvedSpritesSandboxConfig };

export type ResolvedSpritesPluginConfig = ResolvedSpritesCoreConfig & {
  sandbox: ResolvedSpritesSandboxConfig;
};

export const SpritesPluginConfigSchema = SpritesCoreConfigSchema.extend({
  sandbox: SpritesSandboxConfigSchema.optional(),
});

export function resolveSpritesPluginConfig(raw: unknown): ResolvedSpritesPluginConfig {
  const parsed = SpritesPluginConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid plugins.entries.sprites.config: ${issues}`);
  }
  const { sandbox, ...core } = parsed.data;
  return {
    ...resolveSpritesCoreConfig(core),
    sandbox: resolveSpritesSandboxConfig(sandbox),
  };
}

export const SPRITES_PLUGIN_UI_HINTS = {
  ...SPRITES_CORE_UI_HINTS,
  ...SPRITES_SANDBOX_UI_HINTS,
};

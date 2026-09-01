/**
 * Plugin entrypoint: registers the `sprites` sandbox backend and the
 * `openclaw sprites` CLI.
 */
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import { buildPluginConfigSchema, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  SPRITES_BACKEND_ID,
  createSpritesSandboxBackendFactory,
  createSpritesSandboxBackendManager,
  createWakeLogger,
  resolveSpritesWorkdir,
  type SpritesBackendDeps,
} from "./src/sandbox/backend.js";
import { SpritesGateway } from "./src/core/client.js";
import { registerSpritesCli } from "./src/sandbox/cli.js";
import { createInstanceIdResolver } from "./src/sandbox/identity.js";
import {
  SPRITES_PLUGIN_UI_HINTS,
  SpritesPluginConfigSchema,
  resolveSpritesPluginConfig,
  type ResolvedSpritesPluginConfig,
} from "./src/config.js";

const TOKEN_CONFIG_PATH = "plugins.entries.sprites.config.token";

/** Resolves the Sprites token from plugin config (string or SecretRef) or SPRITES_TOKEN. */
export function createTokenResolver(params: {
  pluginConfig: ResolvedSpritesPluginConfig;
  getConfig: () => OpenClawConfig;
}): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    if (cached) {
      return cached;
    }
    cached = (async () => {
      if (params.pluginConfig.token !== undefined) {
        const resolved = await resolveConfiguredSecretInputString({
          config: params.getConfig(),
          env: process.env,
          value: params.pluginConfig.token,
          path: TOKEN_CONFIG_PATH,
        });
        if (resolved.value) {
          return resolved.value;
        }
        throw new Error(
          resolved.unresolvedRefReason ?? `${TOKEN_CONFIG_PATH} resolved to an empty value`,
        );
      }
      const fromEnv = process.env.SPRITES_TOKEN?.trim();
      if (fromEnv) {
        return fromEnv;
      }
      throw new Error(
        `Sprites token missing: set ${TOKEN_CONFIG_PATH} (a string or SecretRef) or export SPRITES_TOKEN for the Gateway.`,
      );
    })().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

export default definePluginEntry({
  id: SPRITES_BACKEND_ID,
  name: "Sprites Sandbox",
  description: "Run OpenClaw sandboxed tool execution inside Fly.io Sprites.",
  configSchema: buildPluginConfigSchema(SpritesPluginConfigSchema, { uiHints: SPRITES_PLUGIN_UI_HINTS }),
  register(api) {
    const pluginConfig = resolveSpritesPluginConfig(api.pluginConfig);
    const resolveToken = createTokenResolver({ pluginConfig, getConfig: () => api.config });
    const resolveInstanceId = createInstanceIdResolver({
      configured: pluginConfig.sandbox.instanceId,
      stateDir: resolveStateDir(),
    });
    const deps: SpritesBackendDeps = { pluginConfig, resolveToken, resolveInstanceId, logger: api.logger };

    api.registerCli(
      ({ program }) => {
        registerSpritesCli(program, {
          pluginConfig,
          resolveInstanceId,
          getClient: async () =>
            new SpritesGateway({
              token: await resolveToken(),
              apiUrl: pluginConfig.apiUrl,
              wake: pluginConfig.wake,
              onWake: createWakeLogger(api.logger),
              requestTimeoutMs: pluginConfig.timeoutMs,
            }),
        });
      },
      {
        descriptors: [
          {
            name: "sprites",
            description: "Inspect and wake Fly.io Sprites used as OpenClaw sandboxes",
            hasSubcommands: true,
          },
        ],
      },
    );

    if (api.registrationMode !== "full") {
      return;
    }
    const unregister = registerSandboxBackend(SPRITES_BACKEND_ID, {
      factory: createSpritesSandboxBackendFactory(deps),
      manager: createSpritesSandboxBackendManager(deps),
      resolveWorkdir: () => resolveSpritesWorkdir(deps),
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: "sprites-sandbox-cleanup",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (sessionKey !== undefined || runId !== undefined) {
          return;
        }
        if (reason === "disable" || reason === "restart") {
          unregister();
        }
      },
    });
  },
});

import { describe, expect, it } from "vitest";
import { resolveSpritesPluginConfig } from "./config.js";

describe("resolveSpritesPluginConfig", () => {
  it("applies defaults", () => {
    const cfg = resolveSpritesPluginConfig(undefined);
    expect(cfg.apiUrl).toBe("https://api.sprites.dev");
    expect(cfg.timeoutMs).toBe(120_000);
    expect(cfg.wake).toEqual({ timeoutMs: 120_000, maxRetryDelayMs: 5_000, keepAwakeMinutes: 0 });
    expect(cfg.sandbox.namePrefix).toBe("openclaw-");
    expect(cfg.sandbox.remoteWorkspaceDir).toBe("/home/sprite/workspace");
    expect(cfg.sandbox.remoteAgentWorkspaceDir).toBe("/home/sprite/agent");
    expect(cfg.sandbox.maxRunAfterDisconnect).toBe("10s");
    expect(cfg.sandbox.checkpointAfterSetup).toBe(false);
  });

  it("accepts a full config with shared keys at the top and sandbox keys nested", () => {
    const cfg = resolveSpritesPluginConfig({
      token: { source: "env", provider: "default", id: "SPRITES_TOKEN" },
      wake: { timeoutSeconds: 30, maxRetrySeconds: 2, keepAwakeMinutes: 15 },
      sandbox: {
        instanceId: "gateway-prod",
        namePrefix: "oc-sandbox-",
        labels: ["team-a"],
        runtime: "dev",
        sprite: { ramMB: 8192, cpus: 4, region: "ord" },
        network: { rules: [{ include: "defaults" }, { domain: "*.github.com", action: "allow" }] },
        privileges: { profile: "minimal", noNewPrivileges: true },
        checkpointAfterSetup: true,
        maxRunAfterDisconnect: "30s",
      },
    });
    expect(cfg.wake).toEqual({ timeoutMs: 30_000, maxRetryDelayMs: 2_000, keepAwakeMinutes: 15 });
    expect(cfg.sandbox.namePrefix).toBe("oc-sandbox-");
    expect(cfg.sandbox.instanceId).toBe("gateway-prod");
    expect(cfg.sandbox.network?.rules).toHaveLength(2);
    expect(cfg.sandbox.privileges?.profile).toBe("minimal");
    expect(cfg.sandbox.maxRunAfterDisconnect).toBe("30s");
  });

  it("rejects unknown keys, sandbox keys at the wrong level, and bad values", () => {
    expect(() => resolveSpritesPluginConfig({ bogus: 1 })).toThrow(/bogus/);
    expect(() => resolveSpritesPluginConfig({ namePrefix: "x" })).toThrow(/namePrefix/);
    expect(() => resolveSpritesPluginConfig({ sandbox: { namePrefix: "Bad_Prefix" } })).toThrow(/namePrefix/);
    expect(() => resolveSpritesPluginConfig({ sandbox: { instanceId: "Bad_ID" } })).toThrow(/instanceId/);
    expect(() =>
      resolveSpritesPluginConfig({ sandbox: { remoteWorkspaceDir: "/w", remoteAgentWorkspaceDir: "/w/agent" } }),
    ).toThrow(/overlap/);
    expect(() => resolveSpritesPluginConfig({ sandbox: { remoteWorkspaceDir: "relative" } })).toThrow(/absolute/);
    expect(() => resolveSpritesPluginConfig({ sandbox: { maxRunAfterDisconnect: "soon" } })).toThrow(/duration/);
  });
});

import { describe, expect, it } from "vitest";
import { spritesPluginConfigSchema } from "./plugin-config-schema.js";

describe("OpenClaw plugin config schema", () => {
  it("preserves Zod transforms when validating through the host contract", () => {
    expect(spritesPluginConfigSchema.safeParse!({
      apiUrl: " https://api.sprites.dev ",
      sandbox: { labels: [" team-a "], remoteWorkspaceDir: " /workspace " },
    })).toEqual({
      success: true,
      data: {
        apiUrl: "https://api.sprites.dev",
        sandbox: { labels: ["team-a"], remoteWorkspaceDir: "/workspace" },
      },
    });
  });

  it.each(["relative", "/", "/workspace/../private"])(
    "rejects the directory %s using runtime refinements",
    (remoteWorkspaceDir) => {
      const result = spritesPluginConfigSchema.safeParse!({ sandbox: { remoteWorkspaceDir } });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        {
          path: ["sandbox", "remoteWorkspaceDir"],
          message: "remoteWorkspaceDir must be an absolute, normalized directory other than /",
        },
      ]);
    },
  );

  it("exposes normalized JSON Schema and configuration UI hints", () => {
    expect(spritesPluginConfigSchema.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        sandbox: {
          type: "object",
          additionalProperties: false,
          properties: { runtime: { type: "string", enum: ["default", "dev"] } },
        },
      },
    });
    expect(spritesPluginConfigSchema.jsonSchema).not.toHaveProperty("$schema");
    expect(spritesPluginConfigSchema.uiHints?.token?.label).toBe("Sprites token");
  });
});

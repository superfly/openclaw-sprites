import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  buildRemoteWorkdirValidationCommand: vi.fn(),
  buildValidatedExecRemoteCommand: vi.fn(),
  createRemoteShellSandboxFsBridge: vi.fn(),
  sanitizeEnvVars: vi.fn(),
  shellEscape: vi.fn(),
}));

import type { SpritesGateway } from "../core/client.js";
import { resolveSpritesPluginConfig } from "../config.js";
import { instanceLabel } from "./backend.js";
import { registerSpritesCli } from "./cli.js";

describe("openclaw sprites status", () => {
  it("shows plugin sprites owned by another Gateway instead of hiding them", async () => {
    const lines: string[] = [];
    const pluginConfig = resolveSpritesPluginConfig(undefined);
    const sprites = [
      {
        id: "1",
        name: "openclaw-current",
        status: "running" as const,
        labels: ["openclaw", instanceLabel("current")],
      },
      {
        id: "2",
        name: "openclaw-other",
        status: "warm" as const,
        labels: ["openclaw", instanceLabel("other")],
      },
    ];
    const client = { listSprites: async () => sprites } as unknown as SpritesGateway;
    const program = new Command();
    program.exitOverride();
    registerSpritesCli(program, {
      pluginConfig,
      resolveInstanceId: async () => "current",
      getClient: async () => client,
      stdout: (line) => lines.push(line),
    });

    await program.parseAsync(["node", "test", "sprites", "status"]);
    const current = lines.find((line) => line.includes("openclaw-current"));
    const other = lines.find((line) => line.includes("openclaw-other"));
    expect(current).not.toContain("another Gateway");
    expect(other).toContain("owned by another Gateway");
  });
});

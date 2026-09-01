import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseShimArgs } from "./exec-shim.js";
import { FakeSpritesServer } from "../test-support/fake-sprites-server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const shimPath = path.resolve(here, "..", "..", "dist", "src", "sandbox", "exec-shim.js");

describe("parseShimArgs", () => {
  it("parses sprite, cwd, tty, and the program argv", () => {
    expect(parseShimArgs(["--sprite", "s", "--cwd", "/w", "--tty", "--", "/bin/sh", "x.sh"])).toEqual({
      sprite: "s",
      cwd: "/w",
      tty: true,
      argv: ["/bin/sh", "x.sh"],
    });
    expect(() => parseShimArgs(["--", "ls"])).toThrow(/--sprite/);
    expect(() => parseShimArgs(["--sprite", "s", "--"])).toThrow(/program/);
    expect(() => parseShimArgs(["--wat"])).toThrow(/Unknown/);
  });
});

describe.skipIf(!existsSync(shimPath))("exec shim process", () => {
  let server: FakeSpritesServer;
  beforeEach(async () => {
    server = new FakeSpritesServer();
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  function runShim(args: string[], input?: string) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [shimPath, ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          OPENCLAW_SPRITES_TOKEN: "org/1/2/tok",
          OPENCLAW_SPRITES_API_URL: server.url,
          OPENCLAW_SPRITES_WAKE_TIMEOUT_MS: "5000",
          OPENCLAW_SPRITES_WAKE_MAX_RETRY_MS: "20",
          OPENCLAW_SPRITES_SHIM_VERBOSE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      if (input !== undefined) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }

  it("wakes a sleeping sprite, streams output, forwards stdin, and propagates the exit code", async () => {
    server.addSprite("sleepy", { status: "cold", startingResponsesLeft: 2 });
    server.execHandler = (_s, req) => ({
      stdout: `ran ${req.argv.join(" ")} in ${req.dir} with ${req.stdin.toString()}`,
      stderr: "note",
      code: 7,
    });
    const result = await runShim(["--sprite", "sleepy", "--cwd", "/home/sprite/workspace", "--", "/bin/sh", "/tmp/x/exec.sh"], "stdin-data");
    expect(result.stderr).toContain("note");
    expect(result.stdout).toBe("ran /bin/sh /tmp/x/exec.sh in /home/sprite/workspace with stdin-data");
    expect(result.stderr).toContain("is asleep; waking it");
    expect(result.stderr).toMatch(/awake after \d+\.\ds/);
    expect(result.code).toBe(7);
  });

  it("fails fast with a clear message when the sprite does not exist", async () => {
    const result = await runShim(["--sprite", "ghost", "--", "true"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ghost/);
  });
});

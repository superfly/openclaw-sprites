import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInstanceIdResolver } from "./identity.js";

describe("createInstanceIdResolver", () => {
  it("persists one identity per OpenClaw state directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sprites-state-"));
    const first = await createInstanceIdResolver({ stateDir })();
    const second = await createInstanceIdResolver({ stateDir })();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
    expect((await fs.readFile(path.join(stateDir, "plugins", "sprites", "instance-id"), "utf8")).trim()).toBe(
      first,
    );
  });

  it("uses the configured identity without writing state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sprites-state-"));
    expect(await createInstanceIdResolver({ configured: "gateway-cluster", stateDir })()).toBe("gateway-cluster");
    await expect(fs.stat(path.join(stateDir, "plugins", "sprites", "instance-id"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpritesGateway, normalizeApiUrl } from "./client.js";
import { FakeSpritesServer } from "../test-support/fake-sprites-server.js";
import type { WakeEvent } from "./wake.js";

describe("normalizeApiUrl", () => {
  it("accepts https and loopback http, rejects the rest", () => {
    expect(normalizeApiUrl("https://api.sprites.dev/")).toBe("https://api.sprites.dev");
    expect(normalizeApiUrl("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(() => normalizeApiUrl("http://api.sprites.dev")).toThrow(/https/);
    expect(() => normalizeApiUrl("https://user:pw@api.sprites.dev")).toThrow(/credentials/);
    expect(() => normalizeApiUrl("nope")).toThrow(/absolute/);
  });
});

describe("SpritesGateway", () => {
  let server: FakeSpritesServer;
  let events: WakeEvent[];
  let gateway: SpritesGateway;

  beforeEach(async () => {
    server = new FakeSpritesServer();
    await server.start();
    events = [];
    gateway = new SpritesGateway({
      token: "org/1/2/secret",
      apiUrl: server.url,
      wake: { timeoutMs: 10_000, maxRetryDelayMs: 50 },
      onWake: (e) => events.push(e),
    });
  });
  afterEach(async () => {
    await server.stop();
  });

  it("returns null for a missing sprite and info for an existing one", async () => {
    expect(await gateway.getSprite("nope")).toBeNull();
    server.addSprite("s1", { labels: ["openclaw"], status: "warm" });
    const info = await gateway.getSprite("s1");
    expect(info?.name).toBe("s1");
    expect(info?.status).toBe("warm");
    expect(info?.labels).toEqual(["openclaw"]);
    expect(await gateway.getSpriteStatus("s1")).toBe("warm");
  });

  it("creates, lists, and deletes sprites with the bearer token", async () => {
    const created = await gateway.createSprite({ name: "openclaw-abc", labels: ["openclaw"], runtime: "dev" });
    expect(created.name).toBe("openclaw-abc");
    expect((await gateway.listSprites("openclaw-")).map((s) => s.name)).toEqual(["openclaw-abc"]);
    await gateway.deleteSprite("openclaw-abc");
    await gateway.deleteSprite("openclaw-abc"); // idempotent
    expect(server.sprites.has("openclaw-abc")).toBe(false);
    expect(server.requestLog.every((r) => r.auth === "Bearer org/1/2/secret")).toBe(true);
  });

  it("wakes a sleeping sprite before exec and reports it once", async () => {
    server.addSprite("sleepy", { status: "cold", startingResponsesLeft: 2 });
    const result = await gateway.exec("sleepy", { argv: ["true"] });
    expect(result.code).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["waking", "waking", "awake"]);
    expect(server.sprites.get("sleepy")?.status).toBe("running");
    // The awake window skips the probe on the next call.
    const probes = () => server.requestLog.filter((r) => r.method === "GET" && r.path.endsWith("/exec")).length;
    const before = probes();
    await gateway.exec("sleepy", { argv: ["true"] });
    expect(probes()).toBe(before);
  });

  it("runs a command with cwd, env, and stdin and returns buffered output", async () => {
    server.addSprite("s1");
    server.execHandler = (_sprite, req) => ({
      stdout: `argv=${req.argv.join(",")} dir=${req.dir} env=${req.env.join(",")} stdin=${req.stdin.toString()}`,
      stderr: "warn",
      code: 3,
    });
    const result = await gateway.exec("s1", {
      argv: ["/bin/sh", "-c", "echo hi", "openclaw-sandbox", "arg1"],
      cwd: "/home/sprite/workspace",
      env: { FOO: "bar" },
      stdin: "input bytes",
      maxRunAfterDisconnect: "30s",
    });
    expect(result.code).toBe(3);
    expect(result.stdout.toString()).toBe(
      "argv=/bin/sh,-c,echo hi,openclaw-sandbox,arg1 dir=/home/sprite/workspace env=FOO=bar stdin=input bytes",
    );
    expect(result.stderr.toString()).toBe("warn");
    expect(server.execLog[0]?.request.maxRunAfterDisconnect).toBe("30s");
  });

  it("streams async iterable stdin without requiring a single buffered payload", async () => {
    server.addSprite("s1");
    server.execHandler = (_sprite, req) => ({ stdout: req.stdin, code: 0 });
    async function* chunks() {
      yield Buffer.from("streamed ");
      yield "input";
    }
    const result = await gateway.exec("s1", { argv: ["/bin/sh", "-c", "cat"], stdin: chunks() });
    expect(result.stdout.toString()).toBe("streamed input");
  });

  it("gives up with a wake timeout error when the sprite never comes back", async () => {
    server.addSprite("stuck", { startingResponsesLeft: 1000 });
    const slow = new SpritesGateway({
      token: "t",
      apiUrl: server.url,
      wake: { timeoutMs: 150, maxRetryDelayMs: 40 },
    });
    await expect(slow.exec("stuck", { argv: ["true"] })).rejects.toThrow(/did not wake within/);
  });

  it("applies policies and manages checkpoints", async () => {
    const sprite = server.addSprite("s1", { startingResponsesLeft: 1 });
    await gateway.setNetworkPolicy("s1", { rules: [{ include: "defaults" }] });
    await gateway.setPrivilegesPolicy("s1", { profile: "minimal", noNewPrivileges: true });
    expect(sprite.networkPolicy).toEqual({ rules: [{ include: "defaults" }] });
    expect(sprite.privilegesPolicy).toEqual({ profile: "minimal", noNewPrivileges: true });
    const id = await gateway.createCheckpoint("s1", "openclaw:setup");
    expect(id).toBe("v1");
    expect((await gateway.listCheckpoints("s1")).map((c) => c.comment)).toEqual(["openclaw:setup"]);
    await gateway.restoreCheckpoint("s1", "v1");
    expect(events.filter((e) => e.type === "waking")).toHaveLength(1);
  });

  it("kills sessions by id", async () => {
    const sprite = server.addSprite("s1");
    await gateway.exec("s1", { argv: ["true"] });
    const [sessionId] = [...sprite.sessions.keys()];
    await gateway.killSession("s1", sessionId!);
    expect(sprite.sessions.get(sessionId!)?.killed).toBe(true);
  });
});

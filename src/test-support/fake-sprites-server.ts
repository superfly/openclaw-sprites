/**
 * A tiny in-process stand-in for api.sprites.dev used by the unit tests.
 *
 * It implements just enough of the control plane and the in-sprite exec
 * WebSocket to exercise the plugin, including the sleep/wake cycle: a sprite
 * marked asleep answers in-sprite requests with 503 `sprite_starting` a
 * configurable number of times before it "wakes".
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type FakeSprite = {
  name: string;
  labels: string[];
  status: "running" | "warm" | "cold";
  /** How many in-sprite requests still return sprite_starting. */
  startingResponsesLeft: number;
  /** Files "on disk" keyed by absolute path, for the shell emulator. */
  files: Map<string, string>;
  networkPolicy?: unknown;
  privilegesPolicy?: unknown;
  checkpoints: Array<{ id: string; comment?: string; create_time: string; files: Map<string, string> }>;
  sessions: Map<string, { command: string[]; killed: boolean }>;
};

export type ExecRequest = {
  argv: string[];
  dir?: string;
  env: string[];
  tty: boolean;
  stdin: Buffer;
  maxRunAfterDisconnect?: string;
};

export type ExecHandler = (
  sprite: FakeSprite,
  request: ExecRequest,
) => { stdout?: Buffer | string; stderr?: Buffer | string; code: number } | Promise<{
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  code: number;
}>;

export class FakeSpritesServer {
  readonly sprites = new Map<string, FakeSprite>();
  readonly execLog: Array<{ sprite: string; request: ExecRequest }> = [];
  readonly requestLog: Array<{ method: string; path: string; auth?: string }> = [];
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  execHandler: ExecHandler = defaultExecHandler;
  networkPolicyFailuresLeft = 0;
  privilegesPolicyFailuresLeft = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  addSprite(name: string, overrides: Partial<FakeSprite> = {}): FakeSprite {
    const sprite: FakeSprite = {
      name,
      labels: [],
      status: "running",
      startingResponsesLeft: 0,
      files: new Map(),
      checkpoints: [],
      sessions: new Map(),
      ...overrides,
    };
    this.sprites.set(name, sprite);
    return sprite;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", this.url);
      const match = url.pathname.match(/^\/v1\/sprites\/([^/]+)\/exec$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const sprite = this.sprites.get(decodeURIComponent(match[1]!));
      this.requestLog.push({ method: "WS", path: url.pathname, auth: req.headers.authorization });
      if (!sprite) {
        socket.write("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{\"error\":\"not_found\"}");
        socket.destroy();
        return;
      }
      if (this.consumeStarting(sprite)) {
        const body = JSON.stringify(startingBody(sprite));
        socket.write(
          `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        void this.handleExec(sprite, url, ws);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private consumeStarting(sprite: FakeSprite): boolean {
    if (sprite.startingResponsesLeft > 0) {
      sprite.startingResponsesLeft -= 1;
      return true;
    }
    sprite.status = "running";
    return false;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const method = req.method ?? "GET";
    this.requestLog.push({ method, path: url.pathname, auth: req.headers.authorization });
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (!req.headers.authorization?.startsWith("Bearer ")) {
      json(401, { error: "unauthorized" });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/sprites") {
      const body = JSON.parse(rawBody) as { name: string; labels?: string[]; runtime?: string };
      if (this.sprites.has(body.name)) {
        json(422, { error: "name_taken" });
        return;
      }
      const sprite = this.addSprite(body.name, { labels: body.labels ?? [] });
      json(200, presentSprite(sprite));
      return;
    }
    if (method === "GET" && url.pathname === "/v1/sprites") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const sprites = [...this.sprites.values()].filter((s) => s.name.startsWith(prefix));
      json(200, { sprites: sprites.map(presentSprite), has_more: false });
      return;
    }
    const spriteMatch = url.pathname.match(/^\/v1\/sprites\/([^/]+)(\/.*)?$/);
    if (!spriteMatch) {
      json(404, { error: "not_found" });
      return;
    }
    const name = decodeURIComponent(spriteMatch[1]!);
    const subpath = spriteMatch[2] ?? "";
    const sprite = this.sprites.get(name);
    if (!sprite) {
      json(404, { error: "not_found", message: `sprite ${name} not found` });
      return;
    }
    if (!subpath) {
      if (method === "GET") {
        json(200, presentSprite(sprite));
        return;
      }
      if (method === "DELETE") {
        this.sprites.delete(name);
        res.writeHead(204).end();
        return;
      }
    }
    // Everything below is served "inside" the sprite and wakes it.
    if (this.consumeStarting(sprite)) {
      json(503, startingBody(sprite));
      return;
    }
    if (method === "GET" && subpath === "/exec") {
      json(200, { sessions: [...sprite.sessions.entries()].map(([id, s]) => ({ id, command: s.command.join(" ") })) });
      return;
    }
    const killMatch = subpath.match(/^\/exec\/([^/]+)\/kill$/);
    if (method === "POST" && killMatch) {
      const session = sprite.sessions.get(decodeURIComponent(killMatch[1]!));
      if (session) {
        session.killed = true;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(JSON.stringify({ type: "complete" }) + "\n");
      return;
    }
    if (method === "POST" && subpath === "/policy/network") {
      if (this.networkPolicyFailuresLeft > 0) {
        this.networkPolicyFailuresLeft -= 1;
        json(500, { error: "transient_policy_failure" });
        return;
      }
      sprite.networkPolicy = JSON.parse(rawBody);
      res.writeHead(204).end();
      return;
    }
    if (method === "POST" && subpath === "/policy/privileges") {
      if (this.privilegesPolicyFailuresLeft > 0) {
        this.privilegesPolicyFailuresLeft -= 1;
        json(500, { error: "transient_policy_failure" });
        return;
      }
      sprite.privilegesPolicy = JSON.parse(rawBody);
      res.writeHead(204).end();
      return;
    }
    if (method === "POST" && subpath === "/checkpoint") {
      const body = JSON.parse(rawBody || "{}") as { comment?: string };
      const id = `v${sprite.checkpoints.length + 1}`;
      sprite.checkpoints.push({
        id,
        comment: body.comment,
        create_time: new Date().toISOString(),
        files: new Map(sprite.files),
      });
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(JSON.stringify({ type: "info", data: `checkpoint ${id}` }) + "\n" + JSON.stringify({ type: "complete" }) + "\n");
      return;
    }
    if (method === "GET" && subpath === "/checkpoints") {
      json(200, sprite.checkpoints.map(({ files: _files, ...checkpoint }) => checkpoint));
      return;
    }
    const restoreMatch = subpath.match(/^\/checkpoints\/([^/]+)\/restore$/);
    if (method === "POST" && restoreMatch) {
      const id = decodeURIComponent(restoreMatch[1]!);
      const checkpoint = sprite.checkpoints.find((candidate) => candidate.id === id);
      if (!checkpoint) {
        json(404, { error: "checkpoint_not_found" });
        return;
      }
      sprite.files = new Map(checkpoint.files);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(JSON.stringify({ type: "complete" }) + "\n");
      return;
    }
    json(404, { error: "not_found", path: subpath });
  }

  private async handleExec(sprite: FakeSprite, url: URL, ws: WebSocket): Promise<void> {
    const params = url.searchParams;
    const path = params.get("path") ?? "bash";
    const cmdParams = params.getAll("cmd");
    // The SDK sends cmd=program plus each arg; sprite-env treats `path` as the program.
    const argv = cmdParams.length > 0 && cmdParams[0] === path ? cmdParams : [path, ...cmdParams];
    const request: ExecRequest = {
      argv,
      dir: params.get("dir") ?? undefined,
      env: params.getAll("env"),
      tty: params.get("tty") === "true",
      stdin: Buffer.alloc(0),
      maxRunAfterDisconnect: params.get("max_run_after_disconnect") ?? undefined,
    };
    const sessionId = `sess-${sprite.sessions.size + 1}`;
    sprite.sessions.set(sessionId, { command: argv, killed: false });
    ws.send(JSON.stringify({ type: "session_info", session_id: sessionId, tty: request.tty }));

    const stdinChunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200); // clients that never send EOF
      ws.on("message", (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (!isBinary) {
          return;
        }
        if (request.tty) {
          stdinChunks.push(buf);
          return;
        }
        if (buf[0] === 0x00) {
          stdinChunks.push(buf.subarray(1));
        } else if (buf[0] === 0x04) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    request.stdin = Buffer.concat(stdinChunks);
    this.execLog.push({ sprite: sprite.name, request });
    const result = await this.execHandler(sprite, request);
    const send = (kind: number, payload: Buffer | string | undefined) => {
      if (payload === undefined || payload.length === 0) {
        return;
      }
      const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
      ws.send(request.tty ? data : Buffer.concat([Buffer.from([kind]), data]));
    };
    send(0x01, result.stdout);
    send(0x02, result.stderr);
    if (!request.tty) {
      ws.send(Buffer.from([0x03, result.code & 0xff]));
    }
    ws.close(result.code === 0 ? 1000 : 1011);
  }
}

function startingBody(sprite: FakeSprite) {
  return {
    error: "sprite_starting",
    sprite_id: `sprite-${sprite.name}`,
    message: `Sprite '${sprite.name}' is starting. Please retry your request.`,
    retry_after_seconds: 1,
  };
}

function presentSprite(sprite: FakeSprite) {
  return {
    id: `sprite-${sprite.name}`,
    name: sprite.name,
    organization: "test-org",
    status: sprite.status,
    url: `https://${sprite.name}-org.sprites.app`,
    labels: sprite.labels,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    last_running_at: null,
  };
}

/**
 * Emulates the handful of `/bin/sh -c <script> openclaw-sandbox <args>` scripts
 * the backend issues, tracking directories and files in memory.
 */
export const defaultExecHandler: ExecHandler = (sprite, request) => {
  const [program, flag, script, , ...args] = request.argv;
  if (program === "true") {
    return { code: 0 };
  }
  if (program === "/bin/sh" && flag === "-c" && script === "true") {
    return { code: 0 };
  }
  if (program !== "/bin/sh" || flag !== "-c" || script === undefined) {
    return { stderr: `fake sprite cannot run ${JSON.stringify(request.argv)}`, code: 127 };
  }
  // Directory / file existence probes.
  if (script.includes('if [ -d "$1" ]')) {
    const dir = args[0] ?? "";
    return { stdout: sprite.files.has(`${dir}/`) ? "1\n" : "0\n", code: 0 };
  }
  if (script.includes('if [ -f "$1" ]')) {
    const value = sprite.files.get(args[0] ?? "");
    return { stdout: value === undefined ? "" : value, code: 0 };
  }
  // Readiness marker.
  if (script.includes('printf "%s\\n" "$2" > "$1"')) {
    sprite.files.set(args[0] ?? "", `${args[1] ?? ""}\n`);
    return { code: 0 };
  }
  // Workspace seeding: rm -rf; mkdir -p; tar -xf -
  if (script.includes("tar -xf -")) {
    const dir = args[0] ?? "";
    sprite.files.set(`${dir}/`, "");
    sprite.files.set(`${dir}/.seeded-bytes`, String(request.stdin.length));
    return { code: 0 };
  }
  if (script.startsWith("mkdir -p")) {
    sprite.files.set(`${args[0] ?? ""}/`, "");
    return { code: 0 };
  }
  // Exec script staging.
  if (script.includes('cat > "$1/exec.sh"')) {
    const dir = args[0] ?? "";
    sprite.files.set(`${dir}/`, "");
    sprite.files.set(`${dir}/exec.sh`, request.stdin.toString("utf8"));
    return { code: 0 };
  }
  if (script.startsWith("rm -f")) {
    sprite.files.delete(args[0] ?? "");
    return { code: 0 };
  }
  if (script.startsWith("rm -rf")) {
    const dir = args[0] ?? "";
    for (const key of [...sprite.files.keys()]) {
      if (key.startsWith(dir)) {
        sprite.files.delete(key);
      }
    }
    if (script.includes("mkdir -p")) {
      sprite.files.set(`${dir}/`, "");
    }
    return { code: 0 };
  }
  // setupCommand runner: cd -- "$1" && sh -lc "$2"
  if (script.includes('sh -lc "$2"')) {
    const command = args[1] ?? "";
    sprite.files.set("/setup-ran", command);
    return command.includes("fail") ? { stderr: "setup exploded", code: 3 } : { code: 0 };
  }
  // Workdir validation: the backend passes the SDK's pre-escaped command string as the script,
  // so the target directory is the first quoted argument after the sentinel.
  const validate = script.match(/'openclaw-validate-workdir' '([^']*)'/);
  if (validate) {
    const target = validate[1] ?? "";
    return sprite.files.has(`${target}/`) ? { stdout: `${target}\n`, code: 0 } : { stderr: "missing", code: 1 };
  }
  return { stderr: `unhandled script: ${script.slice(0, 80)}`, code: 2 };
};

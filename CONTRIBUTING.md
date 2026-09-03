# Contributing to openclaw-sprites

This document covers how the plugin is built, how it fits into OpenClaw, and
how to work on it. For installation and usage, see the [README](README.md).

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md), and see
[SUPPORT.md](SUPPORT.md) for product and account questions.

## Pull requests and review

Search existing issues before opening a bug report or feature request. For
contributions, fork or branch from `main`, keep the change focused, and explain
the user-facing problem and resulting behavior. Update relevant documentation
and tests, then run the development checks below.

Pull requests require the `Validate and test` CI check, one code-owner approval,
an up-to-date branch, and resolved review conversations. New changes dismiss
stale approvals. Use squash or rebase merging to preserve linear history.
Repository administrators can override merge requirements when needed.

Contributions are distributed under the repository's
[Apache License 2.0](LICENSE).

## Development setup

```bash
npm ci --ignore-scripts
npm test          # type-checks, builds dist/, then runs the unit tests
npm run check     # type-check only
npm run build     # compile to dist/
```

To try a local checkout in a real Gateway:

```bash
npm run build
openclaw plugins install --link /path/to/openclaw-sprites
```

Restart the Gateway after linking. The manifest points at `dist/index.js`,
so rebuild after changes.

### Node versions

OpenClaw requires Node 22.22.3+, 24.15+, or 25.9+. The `openclaw` package
enforces this in an install script, so on an older Node you can still get
types for development with:

```bash
npm install --ignore-scripts
```

The `@fly/sprites` SDK declares Node 24 in its `engines` field but runs on
Node 22 as well; the plugin's own `engines` follows OpenClaw's floor.

## How the plugin fits into OpenClaw

OpenClaw 2.0 looks up sandbox backends by ID in a registry. Built-ins are
`docker`, `podman`, and `ssh`; plugins add more with `registerSandboxBackend`
from `openclaw/plugin-sdk/sandbox`. The bundled OpenShell plugin in the
OpenClaw repository (`extensions/openshell`) is the reference for this shape,
and this plugin follows it.

A backend provides three things:

- **A factory** that returns a backend handle for one sandbox scope. The
  handle exposes `buildExecSpec` (returns a local argv for OpenClaw to
  spawn), `runShellCommand` (buffered POSIX scripts used by the filesystem
  bridge), `validateWorkdir`, and `createFsBridge`.
- **A manager** with `describeRuntime` and `removeRuntime`, which power
  `openclaw sandbox list`, `recreate`, and idle pruning.
- **A workdir resolver** so OpenClaw can compute the container working
  directory without starting anything.

The published `openclaw` npm package does not ship type declarations for the
`plugin-sdk/sandbox` subpath. `src/sandbox/openclaw-sandbox-sdk.d.ts` mirrors the
upstream contracts from `src/agents/sandbox/*.types.ts`. Refresh it when the
peer dependency is bumped.

## Architecture

The code is namespaced by capability so more Sprites features can be added
to the same plugin later without mixing them with the sandbox backend. The
plugin ID stays `sprites` regardless; it is the config key, backend ID, and
CLI root, and renaming it would break user config.

```text
src/
  core/                    shared by every capability
    client.ts              SpritesGateway: wake-aware wrapper over the @fly/sprites SDK
    wake.ts                withWake(): bounded retry while the API reports sprite_starting
    protocol.ts            status names and the sprite_starting error shape
    config.ts              shared config: token, apiUrl, timeoutSeconds, wake
  sandbox/                 the sandbox backend capability
    backend.ts             factory, manager, sprite naming, seeding, exec staging, keep-awake
    identity.ts            stable per-Gateway runtime ownership identity
    exec-shim.ts           local process OpenClaw spawns per exec; bridges stdio to the sprite
    cli.ts                 openclaw sprites status|wake|reset|checkpoint
    config.ts              sandbox config: plugins.entries.sprites.config.sandbox
    openclaw-sandbox-sdk.d.ts  types for openclaw/plugin-sdk/sandbox
  config.ts                combines core + capability schemas into the plugin schema
  test-support/            fake Sprites API used by the tests
index.ts                   plugin entry: registers the backend, CLI, and lifecycle cleanup
```

Config follows the same split: shared keys at the top level of
`plugins.entries.sprites.config`, capability keys under their own object
(`sandbox` today). A new capability adds a `src/<name>/` directory, its own
config schema merged in `src/config.ts`, and registrations in `index.ts`.

### Runtime identity

Each sandbox scope maps to one sprite named `<namePrefix><12 hex>` where the
hex is a SHA-256 prefix of the stable Gateway instance ID plus OpenClaw's
scope key. With no explicit `sandbox.instanceId`, `identity.ts` atomically
creates a random ID in `<state dir>/plugins/sprites/instance-id`. The name is
stable within an installation but cannot collide with the same scope on an
unrelated Gateway. Created sprites carry `openclaw`, hashed instance and
scope labels, and a plugin-config fingerprint. The manager and CLI require
the exact instance label before destructive operations.

### Bootstrap

`ensureRuntime` runs once per handle, memoized, and is retried from scratch
if it fails:

1. `GET /v1/sprites/:name`; create the sprite if missing (labels, runtime,
   size from config, `wait_for_capacity`). Refuse to adopt a sprite that
   is not owned by this Gateway instance.
2. Probe the readiness marker `<workspace parent>/.openclaw-sandbox-ready`.
   Its versioned value fingerprints only bootstrap-affecting plugin settings
   plus OpenClaw's workspace access, setup command, and (when setup is used)
   environment. A mismatch fails closed and requires recreation. Operational
   settings such as labels and disconnect timeouts take effect without a
   rebuild.
3. Apply `network` and `privileges` policies. This happens on every incomplete
   bootstrap, including a retry after sprite creation succeeded but a policy
   request failed.
4. Seed the workspace: tar the local directory and stream it as stdin to
   `tar -xf - -C <dir>`. The agent workspace is seeded separately when
   `workspaceAccess` is not `none`, and the skills workspace is copied to
   `.openclaw/sandbox-skills` under the workspace.
5. Export `sandbox.docker.env`, then run `sandbox.docker.setupCommand` with
   `sh -lc`. A non-zero exit fails the bootstrap.
6. Write the readiness marker.
7. Checkpoint with comment `openclaw:setup` if `checkpointAfterSetup` is on,
   so restoring the checkpoint also restores the marker. A checkpoint failure
   removes the marker and leaves bootstrap retryable.

The marker, rather than the workspace directory, is what gates re-seeding,
so a bootstrap that failed halfway is redone instead of being treated as
ready. Materialized skills are refreshed once for each new read-write handle
even when the core runtime is already ready. Tar stdout is passed through as
streaming exec stdin, keeping archive-sized buffers out of the Gateway heap.

### Exec path

`buildExecSpec` stages a script inside the sprite at
`/tmp/openclaw-exec-<uuid>/exec.sh`: it deletes its own directory, exports the
requested environment with shell quoting, then `exec`s the command built by
OpenClaw's `buildValidatedExecRemoteCommand`. Environment values never pass
through argv or the query string.

The returned argv is `node dist/src/sandbox/exec-shim.js --sprite <name> --cwd <dir>
[--tty] -- /bin/sh <script>`. The token and wake settings travel in the
spawned process's environment (`OPENCLAW_SPRITES_*`), not in argv.

The shim wakes the sprite, opens an exec session through the SDK, pipes
stdio, propagates the exit code, and on `SIGTERM`/`SIGINT`/`SIGHUP` signals
the remote process and kills its session by ID. In TTY mode it forwards
terminal resizes.

`finalizeExec` skips remote cleanup when the run completed, since the script
removed its own directory. It only cleans up after a failed launch.

### Filesystem tools

`createFsBridge` hands the work to OpenClaw's shared
`createRemoteShellSandboxFsBridge`, which issues `/bin/sh` scripts through
`runShellCommand`. The remote side needs `/bin/sh`, `python3`, GNU `stat -c`,
and `readlink -f`. The Sprites Ubuntu image provides all of them.

### Sleep and wake

The SDK's WebSocket exec cannot see the HTTP 503 a sleeping sprite returns on
the handshake, so the plugin never opens a session cold. `SpritesGateway.ensureAwake`
issues `GET /v1/sprites/:name/exec` (list sessions) and interprets
`503 {"error":"sprite_starting"}` as "retry". `withWake` retries within
`wake.timeoutSeconds`, pausing for the server's `retry_after_seconds` capped
at `wake.maxRetrySeconds`, and emits `waking`/`awake`/`timeout` events that
the backend logs once. A successful probe is trusted for thirty seconds so a
burst of file operations does not probe every time.

`wake.keepAwakeMinutes` starts a four-minute heartbeat (`true` over exec) the
first time a handle does remote work and stops it once that many minutes have
passed since the last tool call.

### Checkpoints

`openclaw sandbox recreate` deletes the sprite, which also deletes its
checkpoints. `openclaw sprites reset` is the cheaper alternative: it restores
the newest checkpoint whose comment is `openclaw:setup` without recreating
anything. The setup checkpoint contains the versioned ready marker, so a
reset does not accidentally trigger another seed and setup pass.

## Tests

`npm test` builds first (the shim test spawns `dist/src/sandbox/exec-shim.js`) and
then runs vitest.

- `src/test-support/fake-sprites-server.ts` is an in-process stand-in for
  `api.sprites.dev`. It implements sprite CRUD, the exec WebSocket with the
  same frame protocol, policies, checkpoints, session kill, and the
  sleep/wake cycle: a sprite with `startingResponsesLeft > 0` answers
  in-sprite requests with `503 sprite_starting` until the count runs out.
- `src/sandbox/backend.test.ts` and `live.test.ts` mock `openclaw/plugin-sdk/sandbox`
  with small equivalents of the helpers the backend uses, because the real
  module refuses to load on Node versions OpenClaw does not support.
- `src/sandbox/exec-shim.test.ts` runs the compiled shim
  (`dist/src/sandbox/exec-shim.js`) as a child process against the fake server.

### Live test

An opt-in end-to-end check runs against the real API. It creates one sprite
named `openclaw-livetest-<random>`, exercises bootstrap, `setupCommand`,
workdir validation, the exec shim, and the utility contract the filesystem
bridge needs, then deletes the sprite.

```bash
SPRITES_TOKEN=... npm run test:live
```

## Releasing

Run `npm run build` before `npm pack`. The package includes `dist/`,
`openclaw.plugin.json`, the license, and the README. The
`openclaw.extensions` entry in `package.json` points at `dist/index.js`;
keep `openclaw.plugin.json` and the zod schemas in `src/core/config.ts` and
`src/sandbox/config.ts` in sync when adding config keys. Bump `peerDependencies.openclaw` and
`openclaw.compat.pluginApi` together.

## Known gaps and ideas

- Workspace mode is remote-canonical only. OpenShell-style `mirror` mode
  (sync down before exec, sync back after) is not implemented.
- The sandboxed browser is not supported. Chromium as a sprite service with
  CDP tunneled through `/proxy` is a plausible path.
- The in-sprite `/fs/*` endpoints are marked preview upstream; when they
  stabilize they could replace some shell round trips in the filesystem
  bridge.
- Crabbox's Sprites provider ignores caller-supplied lease IDs, which blocks
  using Sprites through OpenClaw's separate cloud-workers feature. That is a
  crabbox change, not a plugin change.

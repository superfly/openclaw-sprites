# openclaw-sprites

Give your OpenClaw agents an isolated, ready-to-use Linux computer in the cloud.

This plugin runs an agent's commands and file tools inside a
[Fly.io Sprite](https://sprites.dev) instead of directly on the computer that
runs your OpenClaw Gateway. Each Sprite is a persistent Ubuntu microVM with
Python, Node, Go, Rust, and other common tools already available.

That means:

- **Less risk to your computer.** Agent commands run in an isolated Sprite,
  while the OpenClaw Gateway stays where it is.
- **No Docker or server setup.** You do not need to build an image, manage SSH
  keys, or install development tools on the Gateway machine.
- **Work survives between conversations.** By default, each agent reuses its
  Sprite until you reset or delete it.
- **You do not pay for an always-on machine.** Idle Sprites automatically
  suspend and wake up the next time the agent needs them.

> [!IMPORTANT]
> The Sprite gets its own copy of the workspace. After the first run, that
> remote copy becomes the agent's working copy; edits are not automatically
> copied back to the Gateway computer. See [Workspace behavior](#workspace-behavior).

## Quick start

You need OpenClaw 2026.8.1 or newer and a Fly.io account. You do **not** need
to install the Sprites CLI.

### 1. Create a Sprites token

Open [sprites.dev/account](https://sprites.dev/account), sign in, and create
an API token. Copy the token; OpenClaw will ask for it in the next step.

For a first test, a normal organization token is fine. Before using the
plugin long-term, consider the restrictions in [Token scoping](#token-scoping).

### 2. Install the plugin and save the token

Run these commands on the same computer that runs the OpenClaw Gateway:

```bash
openclaw plugins install npm:openclaw-sprites
openclaw secrets store set SPRITES_TOKEN --kind secret
```

OpenClaw may ask you to confirm the npm source or plugin capabilities. Check
that the package name is exactly `openclaw-sprites` before accepting.

The second command displays a hidden prompt. Paste the Sprites token and press
Enter. The token is stored as a protected OpenClaw secret instead of being
written into `openclaw.json` or your shell history.

### 3. Turn on Sprites sandboxing

Copy and paste this entire block:

```bash
openclaw config set plugins.entries.sprites.config.token \
  --ref-provider default --ref-source store --ref-id SPRITES_TOKEN
openclaw config set agents.defaults.sandbox.mode all
openclaw config set agents.defaults.sandbox.backend sprites
openclaw config set agents.defaults.sandbox.scope agent
openclaw config set agents.defaults.sandbox.workspaceAccess rw
openclaw plugins enable sprites
openclaw config validate
openclaw gateway restart
```

This creates one Sprite per OpenClaw agent. The same agent reuses that Sprite
across conversations, so installed packages and files remain available.

### 4. Try it

Ask an OpenClaw agent:

> Run `uname -a` and `python3 --version`, then tell me where those commands ran.

The first tool call may take a little longer while the Sprite is created and
the workspace is copied. Later calls reuse it. Confirm that it worked with:

```bash
openclaw sprites status
```

You should see a name beginning with `openclaw-` and a status such as `awake`.
If you do not, start with [First-run troubleshooting](#first-run-troubleshooting).

## What happens behind the scenes

- On the first tool call, the plugin creates a Sprite and copies the workspace
  into it.
- OpenClaw runs `exec`, `read`, `write`, `edit`, `apply_patch`, and `process`
  inside that Sprite.
- The Sprite's disk persists, so packages installed with tools such as `apt`
  or `npm` remain installed.
- The Sprite suspends when idle and wakes automatically for the next tool
  call. See [Sleep and wake](#sleep-and-wake).
- OpenClaw's normal sandbox commands, pruning, tool policy, and workspace
  access rules continue to apply.

## First-run troubleshooting

It is normal for `openclaw sprites status` to show nothing until an agent has
actually tried to run a command or use a file tool.

If the first tool call fails, run these checks in order:

```bash
openclaw config validate
openclaw plugins inspect sprites --runtime
openclaw secrets store list
openclaw gateway status
```

- `plugins inspect` should show the `sprites` plugin and its CLI/backend
  registration. If it does not, run `openclaw plugins enable sprites` and
  `openclaw gateway restart`.
- `secrets store list` should show `SPRITES_TOKEN` as a protected secret. It
  will not display the token itself. If it is missing, run
  `openclaw secrets store set SPRITES_TOKEN --kind secret` again.
- If you replace the stored token while the Gateway is running, run
  `openclaw secrets reload` before trying again.

For live logs while you retry the agent command:

```bash
openclaw logs --follow
```

## Configuration

The quick start is all most people need. Optional plugin settings live under
`plugins.entries.sprites.config`: shared settings at the top level and
sandbox-specific settings under `sandbox`. Only `token` is required; it can
be a protected OpenClaw SecretRef, a string, or the `SPRITES_TOKEN`
environment variable.

### Choose how Sprites are shared

The quick start uses `scope: "agent"`: each agent gets one Sprite and reuses
it across conversations. You can choose a different OpenClaw sandbox scope:

| Scope | What it means | Good for |
| --- | --- | --- |
| `agent` | One Sprite per agent. | Most personal OpenClaw installations. |
| `session` | A separate Sprite for every conversation/session. | Stronger separation between tasks, with more Sprites to manage. |
| `shared` | One Sprite shared by all sandboxed sessions. | A deliberately shared environment. |

For example, switch to one Sprite per session with:

```bash
openclaw config set agents.defaults.sandbox.scope session
openclaw gateway restart
```

`workspaceAccess: "rw"` lets tools read and edit the copied workspace inside
the Sprite. Use `"ro"` when agents should be able to read workspace files but
not change them, or `"none"` for an isolated sandbox workspace.

### Plugin settings

**Top level**

| Key | Default | What it does |
| --- | --- | --- |
| `token` | `SPRITES_TOKEN` env | Sprites API token, as a string or an OpenClaw SecretRef. |
| `wake.timeoutSeconds` | `120` | How long to wait for a sleeping sprite to resume before giving up. |
| `wake.keepAwakeMinutes` | `0` | Keep a sprite awake this long after its last use. `0` lets it sleep. |
| `apiUrl` | `https://api.sprites.dev` | Sprites control plane. |
| `timeoutSeconds` | `120` | Timeout for control-plane requests. |

**`sandbox`**

| Key | Default | What it does |
| --- | --- | --- |
| `instanceId` | generated | Stable Gateway ownership ID. It is persisted in OpenClaw's state directory when omitted; set it explicitly only to share runtimes across a Gateway cluster. |
| `namePrefix` | `openclaw-` | Sandbox sprites are named `<prefix><Gateway-and-scope id>`. Match your token's name prefix. |
| `network` | none | Egress allowlist applied when the sandbox is created. |
| `privileges` | none | Process privilege policy applied before bootstrap, for example `{ profile: "minimal", noNewPrivileges: true }`. |
| `checkpointAfterSetup` | `false` | Snapshot the sprite once the workspace is seeded and `setupCommand` has run. |
| `sprite` | Sprites defaults | Size of new sprites: `ramMB`, `cpus`, `region`, `storageGB`. |
| `runtime` | `default` | Sprite runtime variant, `default` or `dev`. |
| `labels` | `[]` | Extra labels to put on created sprites. |
| `remoteWorkspaceDir` | `/home/sprite/workspace` | Where the workspace lives inside the sprite. |
| `remoteAgentWorkspaceDir` | `/home/sprite/agent` | Read-only copy of the agent workspace when `workspaceAccess` is `ro`. |
| `maxRunAfterDisconnect` | `10s` | How long a command may keep running if the Gateway disconnects. |

A fuller example:

```json5
{
  plugins: {
    entries: {
      sprites: {
        enabled: true,
        config: {
          token: { source: "store", provider: "default", id: "SPRITES_TOKEN" },
          wake: { timeoutSeconds: 120, keepAwakeMinutes: 15 },
          sandbox: {
            namePrefix: "openclaw-",
            network: {
              rules: [
                { include: "defaults" },
                { domain: "*.github.com", action: "allow" },
                { domain: "*.npmjs.org", action: "allow" },
              ],
            },
            privileges: { profile: "minimal", noNewPrivileges: true },
            checkpointAfterSetup: true,
          },
        },
      },
    },
  },
}
```

OpenClaw's own sandbox settings under `agents.defaults.sandbox` apply too
(not to be confused with the plugin's `sandbox` block above).
`docker.setupCommand` runs once inside the new sprite, and `docker.env` sets
environment variables for setup and every tool command. `docker.binds` is not
supported; put the files you need in the workspace instead.

### Token scoping

Create the token with a policy that limits it to this plugin's sprites:

- `name_prefix` equal to your `sandbox.namePrefix` (default `openclaw-`)
- `label` set to `openclaw`
- optionally `max_sprites_total` as a spending guard

Every sprite the plugin creates carries the `openclaw` label, and the plugin
also adds a hashed Gateway-instance ownership label. Destructive plugin and
CLI operations require both labels. A scoped token cannot see or touch
anything else in your organization.

### Runtime identity

Sprite names include both the OpenClaw sandbox scope and a stable identity
for the Gateway installation. When `sandbox.instanceId` is omitted, the
plugin creates one at `<OpenClaw state dir>/plugins/sprites/instance-id`.
Two Gateways using the same Sprites account therefore cannot accidentally
adopt or delete each other's sandbox just because their scope keys match.

## Sleep and wake

Sprites suspend after about ten minutes without activity. A suspended sprite
keeps its disk and costs only storage. The next tool call wakes it, which
usually takes a few seconds.

The plugin makes this predictable:

- **It just works.** Before every command or file operation the plugin checks
  the sprite and, if it is asleep, waits for it to come back. The wait does
  not count against the command's own timeout.
- **You can see it.** The Gateway log shows one line when a wake starts
  (`sprites: sprite openclaw-… is asleep; waking it`) and one when it
  finishes (`… is awake after 6.3s`). If a sprite never comes back, the error
  tells you which setting to change.
- **You can tune it.** Raise `wake.timeoutSeconds` if your sprites are large
  and slow to resume. Set `wake.keepAwakeMinutes` to hold a sprite up between
  tool calls during an active conversation, at the cost of running longer.
- **Background jobs are safe.** A command started with the `process` tool
  keeps the sprite awake until it finishes.

To check what state your sprites are in:

```bash
openclaw sprites status
```

```text
openclaw-3f9a1c2b7d4e   awake                                 last active 2m ago
openclaw-b81e0c55aa71   asleep (warm, resumes in seconds)     last active 3h ago

Sleep/wake: sprites suspend after ~10 idle minutes and resume on the next tool call. Wake budget 120s, keep-awake off (set wake.keepAwakeMinutes to hold a sprite up between calls).
```

To wake one ahead of time, for example before a demo:

```bash
openclaw sprites wake openclaw-b81e0c55aa71
```

## Commands

| Command | What it does |
| --- | --- |
| `openclaw sprites status` | List plugin sandbox sprites and whether each is awake; sprites owned by another Gateway are marked. Add `--json` for machine output. |
| `openclaw sprites wake <name>` | Resume a sleeping sprite now and report how long it took. |
| `openclaw sprites reset <name>` | Restore a sprite to its post-setup checkpoint. Needs `checkpointAfterSetup`. |
| `openclaw sprites checkpoint <name>` | Take a checkpoint. Add `--comment` to label it. |
| `openclaw sandbox list` | OpenClaw's view of all sandbox runtimes, including sprites. |
| `openclaw sandbox recreate` | Delete a sandbox sprite. The next tool call creates a fresh one. |

## Workspace behavior

The first time a sandbox is used, the plugin copies the local workspace into
the sprite. From then on the sprite's copy is the real one: the agent edits
files there, and changes are not synced back to your machine. This matches
OpenClaw's SSH backend. To start over from your local files, run
`openclaw sandbox recreate`.

Materialized sandbox skills are refreshed from OpenClaw when a new
read-write backend handle starts, so skill installs and edits are not pinned
to the sprite's original bootstrap. Directory uploads stream tar output into
the sprite instead of buffering the complete archive in the Gateway.

With `workspaceAccess: "ro"`, the agent workspace is also copied to a
read-only location and write tools are disabled, exactly as with the other
backends.

## Requirements

- OpenClaw 2026.8.1 or newer.
- A Sprites account and API token.

Sprites usage is billed through your Fly.io account. Compute billing stops
while a Sprite is idle, but its stored files persist and may still incur
storage charges. See [Sprites lifecycle and billing](https://docs.sprites.dev/concepts/lifecycle/).

## Troubleshooting

**"Sprites token missing"** — repeat the token and SecretRef setup, then
reload secrets:

```bash
openclaw secrets store set SPRITES_TOKEN --kind secret
openclaw config set plugins.entries.sprites.config.token \
  --ref-provider default --ref-source store --ref-id SPRITES_TOKEN
openclaw secrets reload
```

Advanced installations can instead provide `SPRITES_TOKEN` directly to the
Gateway process; remember that a managed service does not automatically
inherit variables from your interactive shell.

**"Sandbox backend "sprites" is not registered"** — the plugin is not
installed or not enabled. Check `openclaw plugins list`, enable it, and
restart the Gateway.

**"did not wake within 120s"** — the sprite is taking unusually long to
resume. Run `openclaw sprites status` to see its state, try
`openclaw sprites wake <name>`, or raise `wake.timeoutSeconds`.

**"not owned by this Gateway instance"** — a sprite with the generated name
does not have this installation's ownership label. Pick a different
`sandbox.namePrefix`, verify `sandbox.instanceId`, or remove the conflicting
sprite yourself.

**"initialized with a different sandbox configuration"** — a setting that
affects policies, setup, runtime size, or workspace layout changed after the
sprite was initialized. Run `openclaw sandbox recreate` and let the next tool
call bootstrap a fresh runtime. Operational changes such as labels or command
disconnect timeouts do not require recreation.

## Contributing

Development setup, architecture notes, and the test suite are described in
[CONTRIBUTING.md](CONTRIBUTING.md).

For help, see [SUPPORT.md](SUPPORT.md). Report vulnerabilities privately using
[SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE).

/**
 * `openclaw sprites ...` commands. These exist mostly to make the sleep/wake
 * cycle visible: which sandbox sprites exist, whether each is awake, and a
 * one-shot way to wake or reset one.
 */
import type { Command } from "commander";
import { SETUP_CHECKPOINT_COMMENT, OWNER_LABEL, isOwnedSprite } from "./backend.js";
import type { SpritesGateway } from "../core/client.js";
import type { ResolvedSpritesPluginConfig } from "../config.js";
import { describeSpriteStatus, parseSpriteStatus } from "../core/protocol.js";

export type SpritesCliDeps = {
  pluginConfig: ResolvedSpritesPluginConfig;
  resolveInstanceId: () => Promise<string>;
  getClient: () => Promise<SpritesGateway>;
  stdout?: (line: string) => void;
};

function formatAge(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

export function registerSpritesCli(program: Command, deps: SpritesCliDeps): void {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const root = program
    .command("sprites")
    .description("Inspect and wake Fly.io Sprites used as OpenClaw sandboxes");

  root
    .command("status")
    .description("List sandbox sprites and whether each is awake or asleep")
    .option("--json", "print JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = await deps.getClient();
      const instanceId = await deps.resolveInstanceId();
      const sprites = (await client.listSprites(deps.pluginConfig.sandbox.namePrefix)).filter((s) =>
        isOwnedSprite(s.labels),
      );
      if (opts.json) {
        out(
          JSON.stringify(
            sprites.map((sprite) => ({
              ...sprite,
              ownership: isOwnedSprite(sprite.labels, instanceId) ? "current-gateway" : "another-gateway",
            })),
            null,
            2,
          ),
        );
        return;
      }
      if (sprites.length === 0) {
        out(`No sandbox sprites with prefix "${deps.pluginConfig.sandbox.namePrefix}" and label "${OWNER_LABEL}".`);
      }
      for (const sprite of sprites) {
        const status = parseSpriteStatus(sprite.status);
        const columns = [
          sprite.name.padEnd(28),
          describeSpriteStatus(status).padEnd(40),
          `last active ${formatAge(sprite.last_running_at ?? sprite.updated_at)}`,
        ];
        if (!isOwnedSprite(sprite.labels, instanceId)) {
          columns.push("owned by another Gateway");
        }
        out(columns.join("  "));
      }
      const wake = deps.pluginConfig.wake;
      out("");
      out(
        `Sleep/wake: sprites suspend after ~10 idle minutes and resume on the next tool call. ` +
          `Wake budget ${Math.round(wake.timeoutMs / 1000)}s` +
          (wake.keepAwakeMinutes > 0
            ? `, keep-awake ${wake.keepAwakeMinutes}m after the last tool call.`
            : ", keep-awake off (set wake.keepAwakeMinutes to hold a sprite up between calls)."),
      );
    });

  root
    .command("wake <name>")
    .description("Resume a sleeping sandbox sprite now and report how long it took")
    .action(async (name: string) => {
      const client = await deps.getClient();
      await requireOwnedSprite(client, name, await deps.resolveInstanceId());
      const before = await client.getSpriteStatus(name);
      if (before === "missing") {
        throw new Error(`Sprite ${name} does not exist`);
      }
      const startedAt = Date.now();
      out(`${name}: ${describeSpriteStatus(before)}; waking...`);
      await client.exec(name, { argv: ["true"] });
      out(`${name}: awake after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    });

  root
    .command("reset <name>")
    .description("Restore a sandbox sprite to its post-setup checkpoint (requires checkpointAfterSetup)")
    .action(async (name: string) => {
      const client = await deps.getClient();
      await requireOwnedSprite(client, name, await deps.resolveInstanceId());
      const checkpoints = await client.listCheckpoints(name);
      const setup = [...checkpoints]
        .filter((c) => c.comment === SETUP_CHECKPOINT_COMMENT)
        .sort((a, b) => (b.createTime?.getTime() ?? 0) - (a.createTime?.getTime() ?? 0))[0];
      if (!setup) {
        throw new Error(
          `Sprite ${name} has no "${SETUP_CHECKPOINT_COMMENT}" checkpoint. Enable checkpointAfterSetup and recreate the sandbox.`,
        );
      }
      out(`${name}: restoring checkpoint ${setup.id}...`);
      await client.restoreCheckpoint(name, setup.id);
      out(`${name}: restored`);
    });

  root
    .command("checkpoint <name>")
    .description("Create a checkpoint of a sandbox sprite")
    .option("--comment <text>", "checkpoint comment", "openclaw:manual")
    .action(async (name: string, opts: { comment: string }) => {
      const client = await deps.getClient();
      await requireOwnedSprite(client, name, await deps.resolveInstanceId());
      const id = await client.createCheckpoint(name, opts.comment);
      out(`${name}: checkpoint created${id ? ` (${id})` : ""}`);
    });
}

async function requireOwnedSprite(
  client: SpritesGateway,
  name: string,
  instanceId: string,
): Promise<void> {
  const sprite = await client.getSprite(name);
  if (!sprite) {
    throw new Error(`Sprite ${name} does not exist`);
  }
  if (!isOwnedSprite(sprite.labels, instanceId)) {
    throw new Error(`Refusing to operate on sprite ${name}: it is not owned by this Gateway instance`);
  }
}

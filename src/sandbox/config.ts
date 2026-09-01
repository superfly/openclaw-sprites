/**
 * Settings for the sandbox backend: `plugins.entries.sprites.config.sandbox`.
 */
import path from "node:path";
import { z } from "zod";
import type { NetworkPolicy, PrivilegesPolicy } from "../core/client.js";

export const DEFAULT_NAME_PREFIX = "openclaw-";
export const DEFAULT_REMOTE_WORKSPACE_DIR = "/home/sprite/workspace";
export const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/home/sprite/agent";
export const DEFAULT_MAX_RUN_AFTER_DISCONNECT = "10s";

export type ResolvedSpritesSandboxConfig = {
  instanceId?: string;
  namePrefix: string;
  labels: string[];
  runtime?: "default" | "dev";
  sprite: { ramMB?: number; cpus?: number; region?: string; storageGB?: number };
  network?: NetworkPolicy;
  privileges?: PrivilegesPolicy;
  checkpointAfterSetup: boolean;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  maxRunAfterDisconnect: string;
};

const spriteNamePrefix = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]*)*$/, {
    error: "namePrefix must be lowercase alphanumerics and hyphens",
  });

const absoluteRemoteDir = (field: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.startsWith("/") && path.posix.normalize(value) === value && value !== "/", {
      error: `${field} must be an absolute, normalized directory other than /`,
    });

const durationString = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?(?:ms|s|m|h)$/, { error: "expected a Go-style duration such as 10s" });

export const SpritesSandboxConfigSchema = z.strictObject({
  instanceId: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
      error: "instanceId must be lowercase alphanumerics separated by single hyphens",
    })
    .optional(),
  namePrefix: spriteNamePrefix.optional(),
  labels: z.array(z.string().trim().min(1)).optional(),
  runtime: z.enum(["default", "dev"]).optional(),
  sprite: z
    .strictObject({
      ramMB: z.number().int().positive().optional(),
      cpus: z.number().int().positive().optional(),
      region: z.string().trim().min(1).optional(),
      storageGB: z.number().int().positive().optional(),
    })
    .optional(),
  network: z
    .strictObject({
      rules: z.array(
        z.strictObject({
          domain: z.string().trim().min(1).optional(),
          action: z.enum(["allow", "deny"]).optional(),
          include: z.string().trim().min(1).optional(),
        }),
      ),
    })
    .optional(),
  privileges: z
    .strictObject({
      profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
      devices: z.array(z.string()).optional(),
      noNewPrivileges: z.boolean().optional(),
    })
    .optional(),
  checkpointAfterSetup: z.boolean().optional(),
  remoteWorkspaceDir: absoluteRemoteDir("remoteWorkspaceDir").optional(),
  remoteAgentWorkspaceDir: absoluteRemoteDir("remoteAgentWorkspaceDir").optional(),
  maxRunAfterDisconnect: durationString.optional(),
});

export type SpritesSandboxConfigInput = z.infer<typeof SpritesSandboxConfigSchema>;

export function resolveSpritesSandboxConfig(
  input: SpritesSandboxConfigInput | undefined,
): ResolvedSpritesSandboxConfig {
  const value = input ?? {};
  const remoteWorkspaceDir = value.remoteWorkspaceDir ?? DEFAULT_REMOTE_WORKSPACE_DIR;
  const remoteAgentWorkspaceDir = value.remoteAgentWorkspaceDir ?? DEFAULT_REMOTE_AGENT_WORKSPACE_DIR;
  if (
    remoteWorkspaceDir === remoteAgentWorkspaceDir ||
    remoteWorkspaceDir.startsWith(`${remoteAgentWorkspaceDir}/`) ||
    remoteAgentWorkspaceDir.startsWith(`${remoteWorkspaceDir}/`)
  ) {
    throw new Error(
      "Invalid plugins.entries.sprites.config.sandbox: remoteWorkspaceDir and remoteAgentWorkspaceDir must not overlap",
    );
  }
  return {
    instanceId: value.instanceId,
    namePrefix: value.namePrefix ?? DEFAULT_NAME_PREFIX,
    labels: value.labels ?? [],
    runtime: value.runtime,
    sprite: value.sprite ?? {},
    network: value.network,
    privileges: value.privileges,
    checkpointAfterSetup: value.checkpointAfterSetup ?? false,
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
    maxRunAfterDisconnect: value.maxRunAfterDisconnect ?? DEFAULT_MAX_RUN_AFTER_DISCONNECT,
  };
}

export const SPRITES_SANDBOX_UI_HINTS: Record<string, { label: string; help: string; advanced?: boolean }> = {
  sandbox: {
    label: "Sandbox backend",
    help: "Settings for running OpenClaw sandboxed tools inside sprites (backend: \"sprites\").",
  },
  "sandbox.instanceId": {
    label: "Gateway instance ID",
    help: "Stable ownership ID for this Gateway. Generated and persisted automatically when omitted.",
    advanced: true,
  },
  "sandbox.namePrefix": {
    label: "Sprite name prefix",
    help: "Every sandbox sprite is named <prefix><Gateway-and-scope hash>. Match it to the token's name_prefix policy.",
  },
  "sandbox.labels": { label: "Extra labels", help: "Additional labels applied to sandbox sprites.", advanced: true },
  "sandbox.runtime": { label: "Runtime", help: "Sprite runtime variant: default or dev.", advanced: true },
  "sandbox.sprite": { label: "Sprite size", help: "ramMB, cpus, region, storageGB for new sprites.", advanced: true },
  "sandbox.network": {
    label: "Network policy",
    help: "Egress allowlist applied when a sandbox sprite is created.",
  },
  "sandbox.privileges": {
    label: "Privileges policy",
    help: "Process privilege profile applied at creation.",
    advanced: true,
  },
  "sandbox.checkpointAfterSetup": {
    label: "Checkpoint after setup",
    help: "Take a checkpoint once the workspace is seeded and setupCommand has run; `openclaw sprites reset` restores it.",
  },
  "sandbox.remoteWorkspaceDir": {
    label: "Remote workspace dir",
    help: "Writable workspace inside the sprite.",
    advanced: true,
  },
  "sandbox.remoteAgentWorkspaceDir": {
    label: "Remote agent dir",
    help: "Mirror path for the agent workspace when workspaceAccess is read-only.",
    advanced: true,
  },
  "sandbox.maxRunAfterDisconnect": {
    label: "Run after disconnect",
    help: "How long a command may keep running after the Gateway disconnects (default 10s).",
    advanced: true,
  },
};

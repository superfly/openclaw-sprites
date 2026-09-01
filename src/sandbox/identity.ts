import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const INSTANCE_ID_FILE = "instance-id";

/**
 * Resolves a stable Gateway identity. An explicit config value is useful for
 * clustered Gateways; otherwise each OpenClaw state directory gets a random,
 * persistent identity so unrelated installations cannot claim each other's
 * sprites when their scope keys happen to match.
 */
export function createInstanceIdResolver(params: {
  configured?: string;
  stateDir: string;
}): () => Promise<string> {
  if (params.configured) {
    return async () => params.configured!;
  }
  let cached: Promise<string> | null = null;
  return () => {
    cached ??= resolvePersistedInstanceId(params.stateDir).catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

async function resolvePersistedInstanceId(stateDir: string): Promise<string> {
  const pluginDir = path.join(stateDir, "plugins", "sprites");
  const file = path.join(pluginDir, INSTANCE_ID_FILE);
  await fs.mkdir(pluginDir, { recursive: true, mode: 0o700 });
  const existing = await readInstanceId(file);
  if (existing) {
    return existing;
  }

  const generated = randomBytes(16).toString("hex");
  try {
    await fs.writeFile(file, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const raced = await readInstanceId(file);
    if (raced) {
      return raced;
    }
    throw new Error(`Sprites instance identity at ${file} is empty or invalid`);
  }
}

async function readInstanceId(file: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(file, "utf8")).trim();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64) {
      return value;
    }
    if (value) {
      throw new Error(`Sprites instance identity at ${file} is invalid`);
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

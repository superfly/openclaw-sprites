/**
 * Wire-level constants for the Sprites exec WebSocket and the shapes returned by
 * the Sprites control plane. Kept dependency-free so the exec shim can import it.
 */

/** One-byte stream prefixes on non-TTY exec WebSocket frames. */
export const STREAM_STDIN = 0x00;
export const STREAM_STDOUT = 0x01;
export const STREAM_STDERR = 0x02;
export const STREAM_EXIT = 0x03;
export const STREAM_STDIN_EOF = 0x04;

/** Sprite lifecycle states reported by `GET /v1/sprites/:name`. */
export type SpriteStatus = "running" | "warm" | "cold";

export type SpriteInfo = {
  id: string;
  name: string;
  organization?: string;
  status: SpriteStatus | string;
  url?: string;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
  last_running_at?: string | null;
};

/** Error body returned with HTTP 503 while a suspended sprite is being resumed. */
export type SpriteStartingError = {
  error: "sprite_starting";
  sprite_id?: string;
  message?: string;
  retry_after_seconds?: number;
};

export function isSpriteStartingBody(value: unknown): value is SpriteStartingError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "sprite_starting"
  );
}

/** Frames a stdin chunk for the non-TTY exec protocol. */
export function frameStdin(chunk: Uint8Array): Uint8Array {
  const framed = new Uint8Array(chunk.length + 1);
  framed[0] = STREAM_STDIN;
  framed.set(chunk, 1);
  return framed;
}

export function parseSpriteStatus(value: unknown): SpriteStatus {
  return value === "running" || value === "warm" ? value : "cold";
}

/** Human wording for a status, used consistently in logs and CLI output. */
export function describeSpriteStatus(status: SpriteStatus): string {
  switch (status) {
    case "running":
      return "awake";
    case "warm":
      return "asleep (warm, resumes in seconds)";
    default:
      return "asleep (cold, resume may take longer)";
  }
}

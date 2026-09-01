/**
 * Type declarations for `openclaw/plugin-sdk/sandbox`.
 *
 * The published `openclaw` package exports this subpath at runtime but ships no
 * `.d.ts` for it (as of 2026.8.2). These declarations mirror the upstream
 * contracts in `src/agents/sandbox/backend.types.ts`,
 * `backend-handle.types.ts`, `fs-bridge.types.ts`, `remote-fs-bridge.types.ts`,
 * and `registry.ts`. Keep them in sync when bumping the peer dependency.
 */
declare module "openclaw/plugin-sdk/sandbox" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

  export type SandboxBackendId = string;

  export type SandboxBackendExecSpec = {
    argv: string[];
    env: NodeJS.ProcessEnv;
    stdinMode: "pipe-open" | "pipe-closed";
    finalizeToken?: unknown;
  };

  export type SandboxBackendWorkdirValidation = "host" | "backend";
  export type SandboxBackendWorkdirValidator = (workdir: string) => Promise<string | null>;
  export type SandboxBackendPreparedWorkdirDiscarder = (workdir: string) => void;

  export type SandboxBackendCommandParams = {
    script: string;
    args?: string[];
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  };

  export type SandboxBackendCommandResult = {
    stdout: Buffer;
    stderr: Buffer;
    code: number;
  };

  export type SandboxResolvedPath = {
    hostPath?: string;
    relativePath: string;
    containerPath: string;
  };

  export type SandboxFsStat = {
    type: "file" | "directory" | "other";
    size: number;
    mtimeMs: number;
  };

  export type SandboxFsBridge = {
    resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath;
    readFile(params: {
      filePath: string;
      cwd?: string;
      signal?: AbortSignal;
      maxBytes?: number;
    }): Promise<Buffer>;
    copyFile?(params: {
      sourcePath: string;
      destinationPath: string;
      cwd?: string;
      mkdir?: boolean;
      signal?: AbortSignal;
    }): Promise<void>;
    writeFile(params: {
      filePath: string;
      cwd?: string;
      data: Buffer | string;
      encoding?: BufferEncoding;
      mkdir?: boolean;
      signal?: AbortSignal;
    }): Promise<void>;
    createFileExclusive?(params: {
      filePath: string;
      cwd?: string;
      data: Buffer | string;
      encoding?: BufferEncoding;
      mkdir?: boolean;
      signal?: AbortSignal;
    }): Promise<"created" | "exists">;
    mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void>;
    remove(params: {
      filePath: string;
      cwd?: string;
      recursive?: boolean;
      force?: boolean;
      signal?: AbortSignal;
    }): Promise<void>;
    rename(params: { from: string; to: string; cwd?: string; signal?: AbortSignal }): Promise<void>;
    stat(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<SandboxFsStat | null>;
  };

  export type SandboxFsBridgeContext = {
    workspaceDir: string;
    agentWorkspaceDir: string;
    skillsWorkspaceDir?: string;
    readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
    workspaceAccess: "none" | "ro" | "rw";
    containerName: string;
    containerWorkdir: string;
    docker: { binds?: string[] };
    backend?: {
      runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
    };
  };

  export type SandboxBackendHandle = {
    id: SandboxBackendId;
    runtimeId: string;
    runtimeLabel: string;
    workdir: string;
    env?: Record<string, string>;
    configLabel?: string;
    configLabelKind?: string;
    workdirValidation?: SandboxBackendWorkdirValidation;
    validateWorkdir?: SandboxBackendWorkdirValidator;
    discardPreparedWorkdir?: SandboxBackendPreparedWorkdirDiscarder;
    workdirRoots?: readonly string[];
    capabilities?: { browser?: boolean };
    buildExecSpec(params: {
      command: string;
      workdir?: string;
      env: Record<string, string>;
      usePty: boolean;
    }): Promise<SandboxBackendExecSpec>;
    finalizeExec?: (params: {
      status: "completed" | "failed";
      exitCode: number | null;
      timedOut: boolean;
      token?: unknown;
    }) => Promise<void>;
    runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
    createFsBridge?: (params: { sandbox: SandboxFsBridgeContext }) => SandboxFsBridge;
  };

  export type RemoteShellSandboxHandle = {
    remoteWorkspaceDir: string;
    remoteAgentWorkspaceDir: string;
    runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  };

  export type SandboxDockerConfig = {
    image?: string;
    env?: Record<string, string>;
    setupCommand?: string;
    binds?: string[];
    [key: string]: unknown;
  };

  export type SandboxConfig = {
    mode: "off" | "non-main" | "all";
    backend: SandboxBackendId;
    scope: "session" | "agent" | "shared";
    workspaceAccess: "none" | "ro" | "rw";
    workspaceRoot: string;
    docker: SandboxDockerConfig;
    [key: string]: unknown;
  };

  export type SandboxRegistryEntry = {
    containerName: string;
    backendId?: string;
    runtimeLabel?: string;
    sessionKey: string;
    createdAtMs: number;
    lastUsedAtMs: number;
    image: string;
    configLabelKind?: string;
    configHash?: string;
  };

  export type SandboxBackendRuntimeInfo = {
    running: boolean;
    actualConfigLabel?: string;
    configLabelMatch: boolean;
  };

  export type SandboxBackendManager = {
    describeRuntime(params: {
      entry: SandboxRegistryEntry;
      config: OpenClawConfig;
      agentId?: string;
    }): Promise<SandboxBackendRuntimeInfo>;
    removeRuntime(params: {
      entry: SandboxRegistryEntry;
      config: OpenClawConfig;
      agentId?: string;
    }): Promise<void>;
  };

  export type CreateSandboxBackendParams = {
    sessionKey: string;
    scopeKey: string;
    registeredRuntimeIds?: readonly string[];
    workspaceDir: string;
    agentWorkspaceDir: string;
    skillsWorkspaceDir?: string;
    cfg: SandboxConfig;
    requireCurrentConfig?: boolean;
  };

  export type SandboxBackendFactory = (
    params: CreateSandboxBackendParams,
  ) => Promise<SandboxBackendHandle>;

  export type SandboxBackendWorkdirResolver = (params: CreateSandboxBackendParams) => string;

  export type SandboxBackendRegistration =
    | SandboxBackendFactory
    | {
        factory: SandboxBackendFactory;
        manager?: SandboxBackendManager;
        resolveWorkdir?: SandboxBackendWorkdirResolver;
      };

  export function registerSandboxBackend(
    id: SandboxBackendId,
    registration: SandboxBackendRegistration,
  ): () => void;
  export function getSandboxBackendManager(id: string): SandboxBackendManager | null;
  export function createRemoteShellSandboxFsBridge(params: {
    sandbox: SandboxFsBridgeContext;
    runtime: RemoteShellSandboxHandle;
  }): SandboxFsBridge;
  export function buildValidatedExecRemoteCommand(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
  }): string;
  export function buildRemoteWorkdirValidationCommand(params: {
    workdir: string;
    root: string;
  }): string;
  export function buildRemoteCommand(argv: string[]): string;
  export function shellEscape(value: string): string;
  export function sanitizeEnvVars(
    envVars: Record<string, string | undefined>,
    options?: { customBlockedPatterns?: RegExp[] },
  ): { allowed: Record<string, string>; blocked: string[]; warnings: string[] };
}

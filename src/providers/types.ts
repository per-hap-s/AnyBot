import type { SandboxMode } from "../types.js";

export interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

export interface RunOptions {
  workdir: string;
  prompt: string;
  model?: string;
  imagePaths?: string[];
  sessionId?: string;
  sandbox?: SandboxMode;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  longStepStallTimeoutMs?: number;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: ProviderRuntimeEvent) => void;
}

export interface RunResult {
  text: string;
  sessionId: string | null;
}

export interface ProviderCapabilities {
  sessionResume: boolean;
  imageInput: boolean;
  sandbox: boolean;
}

export type ProviderTimeoutKind = "idle" | "long_step_stalled" | "max_runtime";

export type ProviderProgressKind = "progress" | "terminal" | "informational";

export interface ProviderRuntimeEvent {
  type: string;
  threadId?: string;
  itemId?: string;
  itemType?: string;
  itemStatus?: string;
  text?: string;
  command?: string;
  toolName?: string;
  query?: string;
  todoCompleted?: number;
  todoTotal?: number;
  todoCurrentStep?: string;
  aggregatedOutputPreview?: string;
  progressKind?: ProviderProgressKind;
  raw?: unknown;
}

export interface ProviderConfig {
  type: string;
  bin?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

export interface IProvider {
  readonly type: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  listModels(): ProviderModel[];
  run(opts: RunOptions): Promise<RunResult>;
}

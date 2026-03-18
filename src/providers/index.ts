import type { IProvider } from "./types.js";
import { CodexProvider } from "./codex.js";

export const REGISTERED_PROVIDER_TYPE = "codex";

export function createProvider(config?: Record<string, unknown>): IProvider {
  return new CodexProvider({ bin: config?.bin as string | undefined });
}

let currentProvider: IProvider | null = null;

export function getProvider(): IProvider {
  if (!currentProvider) {
    throw new Error("Provider has not been initialized");
  }
  return currentProvider;
}

export function initProvider(config?: Record<string, unknown>): IProvider {
  currentProvider = createProvider(config);
  return currentProvider;
}

export type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
  ProviderConfig,
  ProviderRuntimeEvent,
} from "./types.js";
export { CodexProvider } from "./codex.js";
export {
  ProviderAbortedError,
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
  ProviderParseError,
} from "./codex.js";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProvider, REGISTERED_PROVIDER_TYPE } from "../providers/index.js";
import { getDataDir } from "../runtime-paths.js";

const CONFIG_PATH = path.join(getDataDir(), "model-config.json");

export interface ModelEntry {
  id: string;
  name: string;
  description: string;
}

export interface ModelConfig {
  provider: string;
  currentModel: string;
  models: ModelEntry[];
}

function readEnvModel(): string | null {
  const model = process.env.CODEX_MODEL?.trim();
  return model ? model : null;
}

function buildDefaultConfig(): ModelConfig {
  const provider = getProvider();
  const models = provider.listModels();
  return {
    provider: provider.type,
    currentModel: getDefaultModel(models),
    models,
  };
}

function getCodexConfigPath(): string {
  if (process.env.CODEX_HOME?.trim()) {
    return path.resolve(process.env.CODEX_HOME, "config.toml");
  }

  return path.resolve(os.homedir(), ".codex", "config.toml");
}

function readCodexConfigModel(): string | null {
  const configPath = getCodexConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = readFileSync(configPath, "utf-8");
  let inTopLevel = true;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }

    if (!inTopLevel) {
      continue;
    }

    const match = trimmed.match(/^model\s*=\s*["']([^"']+)["'](?:\s+#.*)?$/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function getDefaultModel(models: ModelEntry[]): string {
  const envModel = readEnvModel();
  if (envModel && models.some((model) => model.id === envModel)) {
    return envModel;
  }

  const configuredModel = readCodexConfigModel();
  if (configuredModel && models.some((model) => model.id === configuredModel)) {
    return configuredModel;
  }

  return models[0]?.id ?? "";
}

function ensureConfig(): void {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(buildDefaultConfig(), null, 2), "utf-8");
  }
}

export function readModelConfig(): ModelConfig {
  ensureConfig();
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as Partial<ModelConfig>;

  const provider = getProvider();
  const models = provider.listModels();
  const envModel = readEnvModel();
  const normalized: ModelConfig = {
    provider: REGISTERED_PROVIDER_TYPE,
    currentModel:
      envModel && models.some((m) => m.id === envModel)
        ? envModel
        : config.currentModel && models.some((m) => m.id === config.currentModel)
        ? config.currentModel
        : getDefaultModel(models),
    models,
  };

  if (
    config.provider !== normalized.provider ||
    config.currentModel !== normalized.currentModel ||
    JSON.stringify(config.models ?? []) !== JSON.stringify(normalized.models)
  ) {
    writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), "utf-8");
  }

  return normalized;
}

export function getCurrentModel(): string {
  return readModelConfig().currentModel;
}

export function getCurrentProviderType(): string {
  return REGISTERED_PROVIDER_TYPE;
}

export function setCurrentModel(modelId: string): ModelConfig {
  const config = readModelConfig();
  const envModel = readEnvModel();
  if (envModel && envModel !== modelId) {
    throw new Error(`Model is locked by CODEX_MODEL=${envModel}`);
  }
  const valid = config.models.some((m) => m.id === modelId);
  if (!valid) {
    throw new Error(`Unsupported model: ${modelId}`);
  }

  const nextConfig: ModelConfig = {
    provider: REGISTERED_PROVIDER_TYPE,
    currentModel: modelId,
    models: config.models,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2), "utf-8");
  return nextConfig;
}

export function getProviderTypes(): Array<{
  type: string;
  displayName: string;
  capabilities: Record<string, boolean>;
}> {
  const provider = getProvider();
  return [
    {
      type: provider.type,
      displayName: provider.displayName,
      capabilities: { ...provider.capabilities },
    },
  ];
}

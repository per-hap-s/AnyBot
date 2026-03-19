import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import type {
  ChannelsConfig,
  FeishuChannelConfig,
  TelegramChannelConfig,
  TelegramFinalReplyMode,
} from "./types.js";
import { getDataDir } from "../runtime-paths.js";

const CONFIG_PATH = path.join(getDataDir(), "channels.json");

const DEFAULT_CONFIG: ChannelsConfig = {
  feishu: {
    enabled: false,
    appId: "",
    appSecret: "",
    groupChatMode: "mention",
    botOpenId: "",
    ackReaction: "OK",
    ownerChatId: "",
  } satisfies FeishuChannelConfig,
  telegram: {
    enabled: false,
    ownerChatId: "",
    botToken: "",
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  } satisfies TelegramChannelConfig,
};

function normalizeTelegramFinalReplyMode(value: unknown): TelegramFinalReplyMode {
  return value === "replace_and_notify" ? "replace_and_notify" : "replace";
}

function ensureConfig(): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  }
}

export function readChannelsConfig(): ChannelsConfig {
  ensureConfig();
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<ChannelsConfig>;
  const feishu = (parsed.feishu ?? {}) as Partial<FeishuChannelConfig>;
  const telegram = (parsed.telegram ?? {}) as Partial<TelegramChannelConfig>;

  return {
    feishu: {
      enabled: typeof feishu.enabled === "boolean"
        ? feishu.enabled
        : DEFAULT_CONFIG.feishu!.enabled,
      appId: typeof feishu.appId === "string" ? feishu.appId : DEFAULT_CONFIG.feishu!.appId,
      appSecret: typeof feishu.appSecret === "string"
        ? feishu.appSecret
        : DEFAULT_CONFIG.feishu!.appSecret,
      groupChatMode: feishu.groupChatMode === "all" ? "all" : DEFAULT_CONFIG.feishu!.groupChatMode,
      botOpenId: typeof feishu.botOpenId === "string"
        ? feishu.botOpenId
        : DEFAULT_CONFIG.feishu!.botOpenId,
      ackReaction: typeof feishu.ackReaction === "string"
        ? feishu.ackReaction
        : DEFAULT_CONFIG.feishu!.ackReaction,
      ownerChatId: typeof feishu.ownerChatId === "string"
        ? feishu.ownerChatId
        : DEFAULT_CONFIG.feishu!.ownerChatId,
    } satisfies FeishuChannelConfig,
    telegram: {
      enabled: typeof telegram.enabled === "boolean"
        ? telegram.enabled
        : DEFAULT_CONFIG.telegram!.enabled,
      ownerChatId: typeof telegram.ownerChatId === "string"
        ? telegram.ownerChatId
        : DEFAULT_CONFIG.telegram!.ownerChatId,
      botToken: typeof telegram.botToken === "string"
        ? telegram.botToken
        : DEFAULT_CONFIG.telegram!.botToken,
      privateOnly: typeof telegram.privateOnly === "boolean"
        ? telegram.privateOnly
        : DEFAULT_CONFIG.telegram!.privateOnly,
      allowGroups: typeof telegram.allowGroups === "boolean"
        ? telegram.allowGroups
        : DEFAULT_CONFIG.telegram!.allowGroups,
      pollingTimeoutSeconds:
        typeof telegram.pollingTimeoutSeconds === "number" &&
        Number.isFinite(telegram.pollingTimeoutSeconds) &&
        telegram.pollingTimeoutSeconds > 0
          ? Math.min(Math.max(Math.round(telegram.pollingTimeoutSeconds), 1), 50)
          : DEFAULT_CONFIG.telegram!.pollingTimeoutSeconds,
      finalReplyMode: normalizeTelegramFinalReplyMode(telegram.finalReplyMode),
    } satisfies TelegramChannelConfig,
  };
}

export function readChannelConfig<T extends ChannelsConfig[string]>(
  channelType: string,
): T | null {
  const config = readChannelsConfig();
  return (config[channelType] as T) ?? null;
}

export function writeChannelsConfig(config: ChannelsConfig): void {
  ensureConfig();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function updateChannelConfig(
  channelType: string,
  partial: Partial<ChannelsConfig[string]>,
): ChannelsConfig {
  if (channelType !== "feishu" && channelType !== "telegram") {
    throw new Error(`Unsupported channel type: ${channelType}`);
  }

  const current = readChannelsConfig();
  const nextConfig: ChannelsConfig = {
    feishu: {
      ...DEFAULT_CONFIG.feishu,
      ...(current.feishu ?? {}),
    } as FeishuChannelConfig,
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...(current.telegram ?? {}),
    } as TelegramChannelConfig,
  };

  if (channelType === "feishu") {
    nextConfig.feishu = {
      ...DEFAULT_CONFIG.feishu,
      ...(current.feishu ?? {}),
      ...(partial ?? {}),
    } as FeishuChannelConfig;
  }
  if (channelType === "telegram") {
    nextConfig.telegram = {
      ...DEFAULT_CONFIG.telegram,
      ...(current.telegram ?? {}),
      ...(partial ?? {}),
    } as TelegramChannelConfig;
  }
  const normalized = {
    ...nextConfig,
    telegram: {
      ...nextConfig.telegram,
      finalReplyMode: normalizeTelegramFinalReplyMode(nextConfig.telegram?.finalReplyMode),
    } as TelegramChannelConfig,
  } satisfies ChannelsConfig;
  writeChannelsConfig(normalized);
  return normalized;
}

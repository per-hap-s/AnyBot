import type { ProviderRuntimeEvent } from "../providers/index.js";

export interface ChannelConfig {
  enabled: boolean;
  ownerChatId?: string;
  [key: string]: unknown;
}

export interface FeishuChannelConfig extends ChannelConfig {
  appId: string;
  appSecret: string;
  groupChatMode: "mention" | "all";
  botOpenId: string;
  ackReaction: string;
}

export interface TelegramChannelConfig extends ChannelConfig {
  botToken: string;
  privateOnly: boolean;
  allowGroups: boolean;
  pollingTimeoutSeconds: number;
}

export interface ChannelsConfig {
  [channelType: string]: ChannelConfig | undefined;
  feishu?: FeishuChannelConfig;
  telegram?: TelegramChannelConfig;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  isCurrent: boolean;
}

export interface ChannelCallbacks {
  generateReply: (
    chatId: string,
    userText: string,
    imagePaths?: string[],
    source?: string,
    onEvent?: (event: ProviderRuntimeEvent) => void,
    signal?: AbortSignal,
  ) => Promise<string>;
  resetSession: (chatId: string, source?: string) => void;
  listModels: () => ModelInfo[];
  switchModel: (modelId: string) => { success: boolean; message: string };
  getMemoryStatus: () => string;
  remember: (text: string) => Promise<{ success: boolean; message: string }>;
  updateProfile: (text: string) => Promise<{ success: boolean; message: string }>;
  compressMemory: () => Promise<{ success: boolean; message: string }>;
}

export interface IChannel {
  readonly type: string;
  start(callbacks: ChannelCallbacks): Promise<void>;
  stop(): Promise<void>;
  sendToOwner(text: string): Promise<void>;
}

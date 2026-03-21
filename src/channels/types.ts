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

export type TelegramFinalReplyMode = "replace" | "replace_and_notify";

export interface TelegramChannelConfig extends ChannelConfig {
  botToken: string;
  privateOnly: boolean;
  allowGroups: boolean;
  pollingTimeoutSeconds: number;
  finalReplyMode: TelegramFinalReplyMode;
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

export interface TelegramTaskAttemptInput {
  attemptId: string;
  taskId: string;
  chatId: string;
  userText: string;
  imagePaths?: string[];
  sessionId?: string | null;
  onEvent?: (event: ProviderRuntimeEvent) => void;
  signal?: AbortSignal;
  canPersist?: () => boolean;
}

export interface TelegramTaskAttemptResult {
  text: string;
  sessionId: string | null;
  repairedIncompleteReply: boolean;
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
  listMemories: () => string;
  remember: (text: string) => Promise<{ success: boolean; message: string }>;
  updateProfile: (text: string) => Promise<{ success: boolean; message: string }>;
  forgetMemory: (text: string) => Promise<{ success: boolean; message: string }>;
  compressMemory: () => Promise<{ success: boolean; message: string }>;
  runTelegramTaskAttempt: (input: TelegramTaskAttemptInput) => Promise<TelegramTaskAttemptResult>;
}

export interface IChannel {
  readonly type: string;
  start(callbacks: ChannelCallbacks): Promise<void>;
  stop(): Promise<void>;
  sendToOwner(text: string): Promise<void>;
}

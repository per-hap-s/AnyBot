import type { IChannel, ChannelCallbacks } from "./types.js";
import { readChannelsConfig } from "./config.js";
import { FeishuChannel } from "./feishu.js";
import { TelegramChannel } from "./telegram.js";
import { logger } from "../logger.js";

const REGISTERED_CHANNEL_TYPES = ["feishu", "telegram"] as const;

type ChannelType = (typeof REGISTERED_CHANNEL_TYPES)[number];
type ChannelFactory = () => IChannel;

const channelFactories: Record<ChannelType, ChannelFactory> = {
  feishu: () => new FeishuChannel(),
  telegram: () => new TelegramChannel(),
};

export function getRegisteredChannelTypes(): string[] {
  return [...REGISTERED_CHANNEL_TYPES];
}

class ChannelManager {
  private runningChannels = new Map<string, IChannel>();
  private callbacks: ChannelCallbacks | null = null;

  async startAll(callbacks: ChannelCallbacks): Promise<IChannel[]> {
    this.callbacks = callbacks;
    const config = readChannelsConfig();
    const started: IChannel[] = [];

    for (const type of REGISTERED_CHANNEL_TYPES) {
      const channelConfig = config[type];
      if (!channelConfig?.enabled) {
        logger.info("channel.skipped", { type, reason: "disabled" });
        continue;
      }

      try {
        const channel = channelFactories[type]();
        await channel.start(callbacks);
        this.runningChannels.set(type, channel);
        started.push(channel);
        logger.info("channel.started", { type });
      } catch (error) {
        logger.error("channel.start_failed", { type, error });
      }
    }

    return started;
  }

  getChannel(type: string): IChannel | undefined {
    return this.runningChannels.get(type);
  }

  getRunningChannelTypes(): string[] {
    return Array.from(this.runningChannels.keys());
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.runningChannels.entries());
    this.runningChannels.clear();

    for (const [type, channel] of entries) {
      try {
        await channel.stop();
        logger.info("channel.stopped", { type });
      } catch (error) {
        logger.error("channel.stop_failed", { type, error });
      }
    }
  }

  async restartChannel(type: string): Promise<void> {
    if (!this.callbacks) {
      logger.warn("channel.restart_skipped", { type, reason: "no callbacks registered" });
      return;
    }

    const existing = this.runningChannels.get(type);
    if (existing) {
      try {
        await existing.stop();
        logger.info("channel.stopped", { type });
      } catch (error) {
        logger.error("channel.stop_failed", { type, error });
      }
      this.runningChannels.delete(type);
    }

    if (!(type in channelFactories)) {
      logger.warn("channel.restart.unknown_type", { type });
      return;
    }

    const config = readChannelsConfig();
    if (!config[type as ChannelType]?.enabled) {
      logger.info("channel.restart.disabled", { type });
      return;
    }

    try {
      const channel = channelFactories[type as ChannelType]();
      await channel.start(this.callbacks);
      this.runningChannels.set(type, channel);
      logger.info("channel.restarted", { type });
    } catch (error) {
      logger.error("channel.restart_failed", { type, error });
    }
  }
}

export const channelManager = new ChannelManager();

export async function startAllChannels(
  callbacks: ChannelCallbacks,
): Promise<IChannel[]> {
  return channelManager.startAll(callbacks);
}

export { readChannelsConfig, readChannelConfig, updateChannelConfig } from "./config.js";
export type {
  IChannel,
  ChannelCallbacks,
  ChannelsConfig,
  ChannelConfig,
  FeishuChannelConfig,
  TelegramChannelConfig,
  TelegramTaskAttemptInput,
  TelegramTaskAttemptResult,
} from "./types.js";

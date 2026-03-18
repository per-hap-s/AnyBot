import { rm } from "node:fs/promises";
import path from "node:path";

import type { FeishuChannelConfig, IChannel, ChannelCallbacks } from "./types.js";
import { readChannelConfig, updateChannelConfig } from "./config.js";
import {
  createLarkClients,
  sendText,
  sendReply,
  sendAckReaction,
  downloadImageFromMessage,
  downloadFileFromMessage,
} from "../lark.js";
import {
  parseIncomingText,
  sanitizeUserText,
  isSupportedFeishuDocumentFileName,
  parseIncomingFileInfo,
  buildUnsupportedFeishuFileMessage,
} from "../message.js";
import { includeContentInLogs, logger, rawLogString } from "../logger.js";
import { handleCommand } from "./commands.js";

import type * as Lark from "@larksuiteoapi/node-sdk";

const shouldLogContent = includeContentInLogs();

const MAX_HANDLED_IDS = 5000;

class CappedSet<T> {
  private set = new Set<T>();
  private queue: T[] = [];
  constructor(private capacity: number) {}

  has(value: T): boolean {
    return this.set.has(value);
  }

  add(value: T): void {
    if (this.set.has(value)) return;
    if (this.set.size >= this.capacity) {
      const oldest = this.queue.shift()!;
      this.set.delete(oldest);
    }
    this.set.add(value);
    this.queue.push(value);
  }
}

export class FeishuChannel implements IChannel {
  readonly type = "feishu";

  private config: FeishuChannelConfig | null = null;
  private larkClient: Lark.Client | null = null;
  private wsClient: ReturnType<typeof createLarkClients>["wsClient"] | null = null;
  private callbacks: ChannelCallbacks | null = null;
  private handledMessageIds = new CappedSet<string>(MAX_HANDLED_IDS);
  private queueByChat = new Map<string, Promise<void>>();
  private workdir = process.env.CODEX_WORKDIR || process.cwd();
  private startedAtMs: number = 0;

  async start(callbacks: ChannelCallbacks): Promise<void> {
    const config = readChannelConfig<FeishuChannelConfig>("feishu");
    if (!config || !config.enabled) {
      logger.info("feishu.skipped", { reason: "disabled or missing config" });
      return;
    }
    if (!config.appId || !config.appSecret) {
      logger.warn("feishu.skipped", { reason: "missing appId or appSecret" });
      return;
    }

    this.config = config;
    this.callbacks = callbacks;
    this.startedAtMs = Date.now();

    const { client, wsClient, EventDispatcher } = createLarkClients(
      config.appId,
      config.appSecret,
    );
    this.larkClient = client;
    this.wsClient = wsClient;

    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": (event: {
        sender: { sender_type: string };
        message: {
          message_id: string;
          create_time?: string;
          chat_id: string;
          chat_type: string;
          message_type: string;
          content: string;
          mentions?: Array<{ id?: { open_id?: string } }>;
        };
      }) => this.handleMessage(event),
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    logger.info("feishu.started", {
      groupChatMode: config.groupChatMode,
      ackReaction: config.ackReaction,
    });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (error) {
        logger.warn("feishu.ws_close_failed", { error });
      }
    }
    this.wsClient = null;
    this.larkClient = null;
    this.callbacks = null;
    this.config = null;
    logger.info("feishu.stopped");
  }

  async sendToOwner(text: string): Promise<void> {
    if (!this.larkClient || !this.config) {
      throw new Error("Feishu channel is not started");
    }
    const ownerChatId = this.config.ownerChatId;
    if (!ownerChatId) {
      throw new Error("Feishu ownerChatId 未配置，请先私聊机器人一次（会自动记录），或在设置中手动填写");
    }
    await sendReply(this.larkClient, ownerChatId, text, this.workdir);
  }

  private shouldReplyInGroup(
    mentions: Array<{ id?: { open_id?: string } }> = [],
  ): boolean {
    if (!this.config) return false;
    if (this.config.groupChatMode === "all") return true;
    if (this.config.botOpenId) {
      return mentions.some((m) => m.id?.open_id === this.config!.botOpenId);
    }
    return mentions.length > 0;
  }

  private enqueueChatTask(chatId: string, task: () => Promise<void>): void {
    const previous = this.queueByChat.get(chatId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.queueByChat.get(chatId) === next) {
          this.queueByChat.delete(chatId);
        }
      });
    this.queueByChat.set(chatId, next);
  }

  private async sendFileProgress(
    client: Lark.Client,
    chatId: string,
    text: string,
  ): Promise<void> {
    try {
      await sendText(client, chatId, text);
    } catch (error) {
      logger.warn("feishu.file.progress_failed", {
        chatId,
        error,
      });
    }
  }

  private async handleMessage(event: {
    sender: { sender_type: string };
    message: {
      message_id: string;
      create_time?: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ id?: { open_id?: string } }>;
    };
  }): Promise<void> {
    const { sender, message } = event;
    const client = this.larkClient!;
    const config = this.config!;

    logger.info("feishu.message.received", {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      senderType: sender.sender_type,
      mentionCount: message.mentions?.length || 0,
      ...(shouldLogContent
        ? { larkContent: rawLogString(message.content) }
        : {}),
    });

    if (sender.sender_type === "app") return;

    const messageCreatedAtMs = message.create_time
      ? Number(message.create_time)
      : 0;
    if (messageCreatedAtMs > 0 && messageCreatedAtMs < this.startedAtMs) {
      logger.info("feishu.message.skipped_stale", {
        messageId: message.message_id,
        messageCreatedAt: messageCreatedAtMs,
        serviceStartedAt: this.startedAtMs,
      });
      return;
    }

    if (this.handledMessageIds.has(message.message_id)) return;
    this.handledMessageIds.add(message.message_id);

    if (
      message.message_type !== "text" &&
      message.message_type !== "image" &&
      message.message_type !== "file"
    ) {
      await sendText(
        client,
        message.chat_id,
        "目前支持文本、图片和常见文档文件。文档类型包括 PDF、Office、CSV/TSV、TXT/Markdown、JSON/YAML/XML，以及常见代码文件。",
      );
      return;
    }

    const isGroup = message.chat_type === "group" || message.chat_type === "group_chat";
    if (!isGroup && !config.ownerChatId) {
      config.ownerChatId = message.chat_id;
      updateChannelConfig("feishu", { ownerChatId: message.chat_id });
      logger.info("feishu.owner_auto_saved", { chatId: message.chat_id });
    }

    if (isGroup) {
      if (!this.shouldReplyInGroup(message.mentions)) return;
    }

    if (message.message_type === "image") {
      void this.processImageMessage(client, config, message);
      return;
    }

    if (message.message_type === "file") {
      void this.processFileMessage(client, config, message);
      return;
    }

    void this.processTextMessage(client, config, message);
  }

  private async processTextMessage(
    client: Lark.Client,
    config: FeishuChannelConfig,
    message: { message_id: string; chat_id: string; content: string },
  ): Promise<void> {
    const rawText = parseIncomingText(message.content);
    const userText = sanitizeUserText(rawText);

    if (!userText) {
      await sendText(client, message.chat_id, "请直接发送文字问题。");
      return;
    }

    const cmd = await handleCommand(userText, message.chat_id, "feishu", this.callbacks!);
    if (cmd.handled) {
      if (cmd.reply) await sendText(client, message.chat_id, cmd.reply);
      return;
    }

    try {
      await sendAckReaction(client, message.message_id, config.ackReaction);
    } catch (error) {
      logger.warn("feishu.ack_failed", {
        messageId: message.message_id,
        error,
      });
    }

    this.enqueueChatTask(message.chat_id, async () => {
      try {
        const reply = await this.callbacks!.generateReply(
          message.chat_id,
          userText,
          undefined,
          "feishu",
        );
        await sendReply(client, message.chat_id, reply, this.workdir);
      } catch (error) {
        logger.error("feishu.text.failed", {
          messageId: message.message_id,
          chatId: message.chat_id,
          error,
        });
        await sendText(client, message.chat_id, "处理消息时出错了，请稍后再试。");
      }
    });
  }

  private async processImageMessage(
    client: Lark.Client,
    config: FeishuChannelConfig,
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    },
  ): Promise<void> {
    try {
      await sendAckReaction(client, message.message_id, config.ackReaction);
    } catch (error) {
      logger.warn("feishu.ack_failed", {
        messageId: message.message_id,
        error,
      });
    }

    let imagePath: string | null = null;

    this.enqueueChatTask(message.chat_id, async () => {
      try {
        imagePath = await downloadImageFromMessage(client, message);
        const userText =
          "用户发来了一张图片。请先根据图片内容直接回答；如果缺少上下文，就先简要描述图片里有什么，并询问对方希望你进一步做什么。";
        const reply = await this.callbacks!.generateReply(
          message.chat_id,
          userText,
          [imagePath],
          "feishu",
        );
        await sendReply(client, message.chat_id, reply, this.workdir);
      } catch (error) {
        logger.error("feishu.image.failed", {
          messageId: message.message_id,
          chatId: message.chat_id,
          error,
        });
        await sendText(
          client,
          message.chat_id,
          "图片收到了，但处理失败。请确认机器人有读取图片资源的权限后再试。",
        );
      } finally {
        if (imagePath) {
          await rm(path.dirname(imagePath), {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      }
    });
  }

  private async processFileMessage(
    client: Lark.Client,
    config: FeishuChannelConfig,
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    },
  ): Promise<void> {
    const fileInfo = parseIncomingFileInfo(message.content);
    const fileName = fileInfo?.fileName || "unknown";

    if (!fileInfo?.fileKey || !fileInfo.fileName) {
      await sendText(
        client,
        message.chat_id,
        "文件收到了，但暂时无法解析这个附件的元信息，请换一个常见文档格式再试。",
      );
      return;
    }

    if (!isSupportedFeishuDocumentFileName(fileInfo.fileName)) {
      await sendText(
        client,
        message.chat_id,
        buildUnsupportedFeishuFileMessage(fileInfo.fileName),
      );
      return;
    }

    try {
      await sendAckReaction(client, message.message_id, config.ackReaction);
    } catch (error) {
      logger.warn("feishu.ack_failed", {
        messageId: message.message_id,
        error,
      });
    }

    await this.sendFileProgress(
      client,
      message.chat_id,
      `已收到文件 \`${fileInfo.fileName}\`，正在下载附件...`,
    );

    let filePath: string | null = null;

    this.enqueueChatTask(message.chat_id, async () => {
      try {
        const downloaded = await downloadFileFromMessage(client, message);
        filePath = downloaded.filePath;
        await this.sendFileProgress(
          client,
          message.chat_id,
          `附件 \`${downloaded.fileName}\` 已下载，正在读取内容...`,
        );
        const userText = [
          "用户发来了一个文件。",
          `文件名: ${downloaded.fileName}`,
          `本地路径: ${downloaded.filePath}`,
          "",
          "请优先读取并理解这个文件，再直接回答用户可能想了解的内容。",
          "如果文件内容不足以完成任务，先简要说明你从文件里看到了什么，再告诉用户你还需要什么上下文。",
          "如果该文件格式不适合直接解析，也请明确说明限制，而不是假装已经读懂。",
        ].join("\n");
        await this.sendFileProgress(
          client,
          message.chat_id,
          `正在分析 \`${downloaded.fileName}\`，请稍候...`,
        );
        const reply = await this.callbacks!.generateReply(
          message.chat_id,
          userText,
          undefined,
          "feishu",
        );
        await sendReply(client, message.chat_id, reply, this.workdir);
      } catch (error) {
        logger.error("feishu.file.failed", {
          messageId: message.message_id,
          chatId: message.chat_id,
          fileName,
          error,
        });
        await sendText(
          client,
          message.chat_id,
          "文件收到了，但处理失败。请确认机器人有读取附件资源的权限，并优先发送常见文档格式。",
        );
      } finally {
        if (filePath) {
          await rm(path.dirname(filePath), {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      }
    });
  }
}

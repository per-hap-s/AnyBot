import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyProxy } from "../proxy.js";
import {
  appendMemoryNote,
  appendProfileNote,
  buildMemoryCompactionPrompt,
  ensureAssistantFiles,
  formatMemoryStatus,
  getMemoryStatus,
} from "../assistant-memory.js";
import { createApp } from "../web/server.js";
import {
  initProvider,
  getProvider,
} from "../providers/index.js";
import {
  includeContentInLogs,
  includePromptInLogs,
  logger,
  rawLogString,
} from "../logger.js";
import {
  getCurrentModel,
  readModelConfig,
  setCurrentModel,
} from "../web/model-config.js";
import {
  startAllChannels,
  channelManager,
  getRegisteredChannelTypes,
  readChannelsConfig,
} from "../channels/index.js";
import type { ChannelCallbacks } from "../channels/index.js";
import type { ProviderRuntimeEvent } from "../providers/index.js";
import * as db from "../web/db.js";
import {
  buildFirstTurnPrompt,
  buildResumePrompt,
  generateId,
  generateTitle,
  getWorkdir,
  getSandbox,
} from "../shared.js";
import { ensureControlToken } from "../control-token.js";
import type { ServiceStatusPayload } from "../service-status.js";

function getProviderConfig(): Record<string, unknown> {
  return {
    bin: process.env.CODEX_BIN,
  };
}

const shouldLogContent = includeContentInLogs();
const shouldLogPrompt = includePromptInLogs();
const MAX_CHAT_SESSIONS = 200;
const WEB_PORT = parseInt(process.env.WEB_PORT || "19981", 10);

class LRUMap<K, V> {
  private map = new Map<K, V>();

  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}

function readAppVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../package.json"),
    path.resolve(here, "../../../package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const filePath of candidates) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // ignore
    }
  }

  return "0.1.0";
}

export class AnyBotService {
  private readonly provider = initProvider(getProviderConfig());
  private readonly controlToken = ensureControlToken();
  private readonly version = readAppVersion();
  private readonly sessionIdByChat = new LRUMap<string, string>(MAX_CHAT_SESSIONS);
  private readonly sessionGenerationByChat = new Map<string, number>();

  private startedAt = Date.now();
  private webServer: Server | null = null;
  private shutdownPromise: Promise<void> | null = null;

  private buildConversationKey(source: string, chatId: string): string {
    return `${source}:${chatId}`;
  }

  private getSessionGeneration(source: string, chatId: string): number {
    return this.sessionGenerationByChat.get(this.buildConversationKey(source, chatId)) || 0;
  }

  private resetChatSession(chatId: string, source: string = "unknown"): void {
    const conversationKey = this.buildConversationKey(source, chatId);
    this.sessionIdByChat.delete(conversationKey);
    this.sessionGenerationByChat.set(
      conversationKey,
      this.getSessionGeneration(source, chatId) + 1,
    );
    db.detachChatId(source, chatId);
  }

  private hydrateChannelSessions(): void {
    const recoverableSessions = db.listRecoverableChannelSessions();

    for (const session of recoverableSessions) {
      this.sessionIdByChat.set(
        this.buildConversationKey(session.source, session.chatId),
        session.sessionId,
      );
    }

    logger.info("service.channel_sessions_hydrated", {
      count: recoverableSessions.length,
    });
  }

  private getOrCreateChannelSession(
    source: string,
    chatId: string,
  ): db.ChatSession {
    const existing = db.findSessionBySourceChat(source, chatId);
    if (existing) return existing;

    const session: db.ChatSession = {
      id: generateId(),
      title: "New Chat",
      sessionId: null,
      source,
      chatId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.createSession(session);
    return session;
  }

  private async generateReply(
    chatId: string,
    userText: string,
    imagePaths: string[] = [],
    source: string = "unknown",
    onEvent?: (event: ProviderRuntimeEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const conversationKey = this.buildConversationKey(source, chatId);
    const dbSession = this.getOrCreateChannelSession(source, chatId);
    const sessionId = this.sessionIdByChat.get(conversationKey) || dbSession.sessionId || null;
    const sessionGeneration = this.getSessionGeneration(source, chatId);
    const prompt = sessionId
      ? buildResumePrompt(userText, source)
      : buildFirstTurnPrompt(userText, source);

    db.addMessage(dbSession.id, "user", userText);

    if (dbSession.messages.length <= 1) {
      dbSession.title = generateTitle(userText);
    }

    logger.info("reply.generate.start", {
      chatId,
      source,
      provider: getProvider().type,
      mode: sessionId ? "resume" : "new",
      sessionId: sessionId || null,
      dbSessionId: dbSession.id,
      userTextChars: userText.length,
      imageCount: imagePaths.length,
      promptChars: prompt.length,
      ...(shouldLogContent ? { userText: rawLogString(userText) } : {}),
      ...(shouldLogPrompt ? { prompt: rawLogString(prompt) } : {}),
    });

    const result = await getProvider().run({
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      model: getCurrentModel(),
      prompt,
      imagePaths,
      sessionId: sessionId || undefined,
      signal,
      onEvent,
    });

    if (signal?.aborted) {
      throw new Error("Reply generation aborted");
    }

    if (result.sessionId && sessionGeneration === this.getSessionGeneration(source, chatId)) {
      this.sessionIdByChat.set(conversationKey, result.sessionId);
    }

    db.addMessage(dbSession.id, "assistant", result.text);
    db.updateSession({
      id: dbSession.id,
      title: dbSession.title,
      sessionId: result.sessionId || dbSession.sessionId,
      updatedAt: Date.now(),
    });

    logger.info("reply.generate.success", {
      chatId,
      source,
      provider: getProvider().type,
      sessionId: result.sessionId,
      dbSessionId: dbSession.id,
      replyChars: result.text.length,
      ...(shouldLogContent ? { replyText: rawLogString(result.text) } : {}),
    });

    return result.text;
  }

  private listModels() {
    const config = readModelConfig();
    return config.models.map((m) => ({
      ...m,
      isCurrent: m.id === config.currentModel,
    }));
  }

  private handleSwitchModel(modelId: string) {
    try {
      const config = setCurrentModel(modelId);
      return {
        success: true,
        message: `Switched model to: ${config.currentModel}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to switch model";
      return { success: false, message };
    }
  }

  private getMemoryStatusSummary(): string {
    return formatMemoryStatus(getMemoryStatus(getWorkdir()));
  }

  private async rememberMemory(text: string): Promise<{ success: boolean; message: string }> {
    const result = appendMemoryNote(text, getWorkdir());
    return {
      success: result.changed,
      message: result.changed ? `Saved to MEMORY.md: ${text}` : result.message,
    };
  }

  private async updateProfile(text: string): Promise<{ success: boolean; message: string }> {
    const result = appendProfileNote(text, getWorkdir());
    return {
      success: result.changed,
      message: result.changed ? `Saved to PROFILE.md: ${text}` : result.message,
    };
  }

  private async compressMemory(): Promise<{ success: boolean; message: string }> {
    const before = getMemoryStatus(getWorkdir());
    if (!before.needsCompaction) {
      return {
        success: false,
        message: `MEMORY.md is ${before.memoryBytes} bytes, below the ${before.compactThresholdBytes} byte threshold.`,
      };
    }

    const result = await this.provider.run({
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      model: getCurrentModel(),
      prompt: buildMemoryCompactionPrompt(before),
    });

    const after = getMemoryStatus(getWorkdir());
    const delta = before.memoryBytes - after.memoryBytes;
    const deltaText = delta > 0 ? ` Reduced by ${delta} bytes.` : "";

    return {
      success: true,
      message: `Compacted MEMORY.md. It is now ${after.memoryBytes} bytes.${deltaText}\n\n${result.text}`,
    };
  }

  getStatus(): ServiceStatusPayload {
    const channelsConfig = readChannelsConfig();
    return {
      ok: true,
      app: "anybot",
      version: this.version,
      pid: process.pid,
      webPort: WEB_PORT,
      provider: this.provider.type,
      currentModel: getCurrentModel(),
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      channels: {
        registered: getRegisteredChannelTypes(),
        running: channelManager.getRunningChannelTypes(),
        feishuEnabled: Boolean(channelsConfig.feishu?.enabled),
        telegramEnabled: Boolean(channelsConfig.telegram?.enabled),
      },
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    ensureAssistantFiles(getWorkdir());

    try {
      applyProxy();
    } catch (error) {
      logger.warn("proxy.init_failed", { error });
    }

    logger.info("service.starting", {
      provider: this.provider.type,
      providerDisplayName: this.provider.displayName,
      model: getCurrentModel(),
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      logIncludeContent: shouldLogContent,
      logIncludePrompt: shouldLogPrompt,
      webPort: WEB_PORT,
    });

    this.hydrateChannelSessions();

    const channelCallbacks: ChannelCallbacks = {
      generateReply: (chatId, userText, imagePaths, source, onEvent, signal) =>
        this.generateReply(chatId, userText, imagePaths, source, onEvent, signal),
      resetSession: (chatId, source) => this.resetChatSession(chatId, source),
      listModels: () => this.listModels(),
      switchModel: (modelId) => this.handleSwitchModel(modelId),
      getMemoryStatus: () => this.getMemoryStatusSummary(),
      remember: (text) => this.rememberMemory(text),
      updateProfile: (text) => this.updateProfile(text),
      compressMemory: () => this.compressMemory(),
    };

    const webApp = createApp({
      getStatus: () => this.getStatus(),
      controlToken: this.controlToken,
      requestShutdown: () => {
        void this.shutdownAndExit("api");
      },
    });

    await new Promise<void>((resolve, reject) => {
      const server = webApp.listen(WEB_PORT, () => {
        logger.info("web.started", { port: WEB_PORT });
        console.log(`AnyBot 界面： http://localhost:${WEB_PORT}`);
        resolve();
      });
      server.once("error", (error) => {
        reject(error);
      });
      this.webServer = server;
    });

    const channels = await startAllChannels(channelCallbacks);
    logger.info("service.started", {
      activeChannels: channels.map((c) => c.type),
    });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      logger.info("service.stopping", { reason });

      await channelManager.stopAll();

      if (this.webServer) {
        await new Promise<void>((resolve) => {
          this.webServer?.close(() => resolve());
        });
        this.webServer = null;
      }

      try {
        db.closeDb();
      } catch (error) {
        logger.warn("service.db_close_failed", { error });
      }

      logger.info("service.stopped", { reason });
    })();

    return this.shutdownPromise;
  }

  async shutdownAndExit(reason: string): Promise<never> {
    try {
      await this.shutdown(reason);
      process.exit(0);
    } catch (error) {
      logger.error("service.stop_failed", { reason, error });
      process.exit(1);
    }
  }
}

export async function startCliService(): Promise<void> {
  const service = new AnyBotService();

  const handleSignal = (signal: NodeJS.Signals) => {
    void service.shutdownAndExit(signal);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  await service.start();
}

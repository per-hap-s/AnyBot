import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyProxy } from "../proxy.js";
import {
  ensureAssistantFiles,
} from "../assistant-memory.js";
import { createApp } from "../web/server.js";
import {
  initProvider,
  getProvider,
  ProviderTimeoutError,
  shouldRetryFreshSessionAfterTimeout,
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
import type { ChannelCallbacks, IChannel } from "../channels/index.js";
import type { ProviderRuntimeEvent } from "../providers/index.js";
import type { RunResult } from "../providers/index.js";
import * as db from "../web/db.js";
import {
  buildFirstTurnPrompt,
  buildResumePrompt,
  generateId,
  generateTitle,
  getWorkdir,
  getSandbox,
} from "../shared.js";
import {
  ensureCompletedUserReply,
} from "../reply-completion.js";
import { ensureControlToken } from "../control-token.js";
import type { ServiceStatusPayload } from "../service-status.js";
import {
  appendDailyMemoryInvalidation,
  appendDailyMemoryFact,
  buildRelevantMemoryPromptSection,
  createEmbedding,
  enqueueMemoryJob,
  enqueueAutomaticMemoryJobs,
  enqueuePromotionJob,
  extractDurableFacts,
  getCanonicalMemoryById,
  invalidateMemoryEntries,
  listActiveCanonicalMemoriesByScope,
  listMemoryEntriesByScope,
  markCanonicalMemoryEmbedding,
  MEMORY_CANONICAL_EMBED_JOB_KIND,
  MEMORY_EMBED_JOB_KIND,
  MEMORY_INVALIDATION_JOB_KIND,
  MEMORY_JOB_KIND,
  MEMORY_PROMOTION_JOB_KIND,
  markMemoryEntryEmbedding,
  MemoryWorker,
  type MemoryScope,
  OWNER_PRIVATE_MEMORY_SCOPE,
  promoteCanonicalMemories,
  recoverRunningMemoryJobs,
  isMemoryQuestion,
  retrieveRelevantCanonicalMemories,
  resolveUnifiedPrivateMemoryScope,
  saveExtractedFact,
  selectMemoriesToInvalidate,
  syncCanonicalMemories,
} from "../memory/index.js";

function getProviderConfig(): Record<string, unknown> {
  return {
    bin: process.env.CODEX_BIN,
  };
}

const shouldLogContent = includeContentInLogs();
const shouldLogPrompt = includePromptInLogs();
const MAX_CHAT_SESSIONS = 200;
const WEB_PORT = parseInt(process.env.WEB_PORT || "19981", 10);
const CODEX_STARTUP_TEXT_TIMEOUT_MS = 60_000;
const CODEX_STARTUP_RESUME_TIMEOUT_MS = 90_000;
const CODEX_STARTUP_IMAGE_TIMEOUT_MS = 90_000;
const CODEX_STARTUP_RETRY_ATTEMPTS = 2;
const CODEX_PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5W0AAAAASUVORK5CYII=";

type CodexStartupStatus = {
  label: "正常" | "异常";
  healthy: boolean;
  checkedAt: number;
  passedChecks: string[];
  detail?: string;
  checks: {
    text: CodexCheckStatus;
    resume: CodexCheckStatus;
    image: CodexCheckStatus;
  };
};

type CodexCheckStatus = {
  label: "正常" | "异常" | "未检查" | "跳过";
  healthy: boolean;
  detail?: string;
};

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

function formatStartupTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(timestamp);
}

function buildCodexProbePrompt(token: string, mode: "text" | "resume"): string {
  const instructions = {
    text: "This is an AnyBot startup self-check for normal text answering.",
    resume: "This is an AnyBot startup self-check for session resume.",
  } satisfies Record<"text" | "resume", string>;

  return [
    instructions[mode],
    `Reply with exactly ${token}`,
    "Do not add punctuation, quotes, markdown, code fences, or extra words.",
  ].join("\n");
}

function isExpectedProbeReply(text: string, token: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const unfenced = trimmed
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const unquoted = unfenced.replace(/^["'`]+|["'`]+$/g, "").trim();
  return unquoted === token;
}

function buildCodexImageProbePrompt(token: string): string {
  return [
    "This is an AnyBot startup self-check for image transport.",
    "An image is attached.",
    "Ignore the image contents.",
    `Reply with exactly ${token}`,
    "Do not add punctuation, quotes, markdown, code fences, or extra words.",
  ].join("\n");
}

function createPendingCodexCheckStatus(): CodexCheckStatus {
  return {
    label: "未检查",
    healthy: false,
  };
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
  private codexStartupStatus: CodexStartupStatus | null = null;
  private readonly memoryWorker = new MemoryWorker({
    extract_memory: (payload) => this.runExtractMemoryJob(payload),
    embed_memory_entry: (payload) => this.runEmbedMemoryJob(payload),
    embed_canonical_memory: (payload) => this.runEmbedCanonicalMemoryJob(payload),
    invalidate_memory: (payload) => this.runInvalidateMemoryJob(payload),
    promote_memory_scope: (payload) => this.runPromoteMemoryScopeJob(payload),
  });

  private buildConversationKey(source: string, chatId: string): string {
    return `${source}:${chatId}`;
  }

  private buildPrivateMemoryScopeForChat(source: string, chatId: string): MemoryScope | null {
    return resolveUnifiedPrivateMemoryScope(source, chatId);
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
    const memoryScope = this.buildPrivateMemoryScopeForChat(source, chatId);
    const memoryContext = await this.buildMemoryContextForReply(memoryScope, userText);
    const freshPrompt = buildFirstTurnPrompt(userText, source, memoryContext);
    const prompt = sessionId
      ? buildResumePrompt(userText, source, memoryContext)
      : freshPrompt;
    let expectedSessionGeneration = this.getSessionGeneration(source, chatId);

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

    let result: RunResult;
    try {
      result = await getProvider().run({
        workdir: getWorkdir(),
        sandbox: getSandbox(),
        model: getCurrentModel(),
        prompt,
        imagePaths,
        sessionId: sessionId || undefined,
        signal,
        onEvent,
      });
    } catch (error) {
      const shouldRetryFresh = Boolean(
        sessionId
        && !signal?.aborted
        && shouldRetryFreshSessionAfterTimeout(error),
      );
      if (!shouldRetryFresh) {
        throw error;
      }

      logger.warn("reply.generate.resume_timeout_retrying_fresh", {
        chatId,
        source,
        provider: getProvider().type,
        staleSessionId: sessionId,
        dbSessionId: dbSession.id,
        timeoutKind: (error as ProviderTimeoutError).kind,
      });

      this.sessionIdByChat.delete(conversationKey);
      this.sessionGenerationByChat.set(
        conversationKey,
        this.getSessionGeneration(source, chatId) + 1,
      );
      expectedSessionGeneration = this.getSessionGeneration(source, chatId);
      db.updateSession({
        id: dbSession.id,
        title: dbSession.title,
        sessionId: null,
        updatedAt: Date.now(),
      });
      dbSession.sessionId = null;

      result = await getProvider().run({
        workdir: getWorkdir(),
        sandbox: getSandbox(),
        model: getCurrentModel(),
        prompt: freshPrompt,
        imagePaths,
        signal,
        onEvent,
      });
    }

    if (signal?.aborted) {
      throw new Error("Reply generation aborted");
    }

    const continuationSessionIdFallback = result.sessionId
      || this.sessionIdByChat.get(conversationKey)
      || dbSession.sessionId
      || null;

    const completionOutcome = await ensureCompletedUserReply({
      userText,
      result,
      sessionIdFallback: continuationSessionIdFallback,
      continueRun: async (continuationSessionId, continuationPrompt) => {
        logger.warn("reply.generate.incomplete_reply_retrying", {
          chatId,
          source,
          provider: getProvider().type,
          sessionId: continuationSessionId,
          dbSessionId: dbSession.id,
          replyPreview: result.text.slice(0, 120),
        });

        return getProvider().run({
          workdir: getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: continuationPrompt,
          sessionId: continuationSessionId,
          signal,
          onEvent,
        });
      },
    });
    result = completionOutcome.result;
    const effectiveSessionId = result.sessionId
      || (completionOutcome.repaired ? continuationSessionIdFallback : null)
      || dbSession.sessionId
      || null;

    if (completionOutcome.repaired) {
      logger.info("reply.generate.incomplete_reply_repaired", {
        chatId,
        source,
        provider: getProvider().type,
        sessionId: effectiveSessionId,
        dbSessionId: dbSession.id,
        replyChars: result.text.length,
      });
    }

    if (effectiveSessionId && expectedSessionGeneration === this.getSessionGeneration(source, chatId)) {
      this.sessionIdByChat.set(conversationKey, effectiveSessionId);
    }

    db.addMessage(dbSession.id, "assistant", result.text);
    db.updateSession({
      id: dbSession.id,
      title: dbSession.title,
      sessionId: effectiveSessionId,
      updatedAt: Date.now(),
    });

    logger.info("reply.generate.success", {
      chatId,
      source,
      provider: getProvider().type,
      sessionId: effectiveSessionId,
      dbSessionId: dbSession.id,
      replyChars: result.text.length,
      ...(shouldLogContent ? { replyText: rawLogString(result.text) } : {}),
    });

    if (this.buildPrivateMemoryScopeForChat(source, chatId)) {
      enqueueAutomaticMemoryJobs({
        source,
        chatId,
        userText,
        assistantText: result.text,
      });
    }

    return result.text;
  }

  private async buildMemoryContextForReply(
    scope: MemoryScope | null,
    userText: string,
  ): Promise<string> {
    if (!scope) {
      return "";
    }

    try {
      const hits = await retrieveRelevantCanonicalMemories(scope, userText);
      logger.info("memory.retrieve.completed", {
        scope,
        queryChars: userText.length,
        hitCount: hits.length,
        hits: hits.map((hit) => ({
          id: hit.id,
          text: hit.text,
          score: Number(hit.score.toFixed(4)),
        })),
      repairedIncompleteReply: completionOutcome.repaired,
      });
      return buildRelevantMemoryPromptSection(hits, {
        isMemoryQuestion: isMemoryQuestion(userText),
      });
    } catch (error) {
      logger.warn("memory.retrieve.failed", {
        scope,
        error,
      });
      return "";
    }
  }

  private async runExtractMemoryJob(payload: Record<string, unknown>): Promise<void> {
    const source = typeof payload.source === "string" ? payload.source : "unknown";
    const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    const userText = typeof payload.userText === "string" ? payload.userText : "";
    const assistantText = typeof payload.assistantText === "string" ? payload.assistantText : "";

    if (!chatId || !userText || !assistantText) {
      throw new Error("Invalid memory extraction payload");
    }

    const facts = await extractDurableFacts(this.provider, {
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      userText,
      assistantText,
    });

    const scope = this.buildPrivateMemoryScopeForChat(source, chatId);
    if (!scope) {
      logger.info("memory.extract.skipped", {
        source,
        chatId,
        reason: "non_private_chat",
      });
      return;
    }
    let insertedCount = 0;

    for (const fact of facts) {
      const saved = saveExtractedFact(scope, {
        ...fact,
        sourceRef: `${source}:${chatId}`,
      });

      const entry = db.getMemoryEntryById(saved.id);
      if (entry && entry.status === "active" && entry.embeddingStatus !== "ready") {
        enqueueMemoryJob(MEMORY_EMBED_JOB_KIND, saved.id, {
          entryId: saved.id,
        });
      }

      if (saved.inserted) {
        appendDailyMemoryFact(getWorkdir(), scope, {
          ...fact,
          sourceRef: `${source}:${chatId}`,
        });
        insertedCount += 1;
      }
    }

    logger.info("memory.extract.completed", {
      source,
      chatId,
      factCount: facts.length,
      insertedCount,
    });

    if (insertedCount > 0) {
      enqueuePromotionJob(scope, `${Date.now()}:${insertedCount}`);
    }
  }

  private async runEmbedMemoryJob(payload: Record<string, unknown>): Promise<void> {
    const entryId = typeof payload.entryId === "string" ? payload.entryId : "";
    if (!entryId) {
      throw new Error("Invalid memory embedding payload");
    }

    const entry = db.getMemoryEntryById(entryId);
    if (!entry) {
      logger.info("memory.embed.skipped", {
        entryId,
        reason: "missing_entry",
      });
      return;
    }

    if (entry.status !== "active") {
      logger.info("memory.embed.skipped", {
        entryId,
        reason: "inactive_entry",
        status: entry.status,
      });
      return;
    }

    if (entry.embeddingStatus === "ready" && entry.embeddingModel && entry.embeddingJson) {
      logger.info("memory.embed.skipped", {
        entryId,
        reason: "already_ready",
        model: entry.embeddingModel,
      });
      return;
    }

    try {
      const result = await createEmbedding(entry.text);
      markMemoryEntryEmbedding(
        entryId,
        "ready",
        result.model,
        JSON.stringify(result.embedding),
      );

      logger.info("memory.embed.completed", {
        entryId,
        model: result.model,
        dimensions: result.embedding.length,
      });
    } catch (error) {
      markMemoryEntryEmbedding(entryId, "failed", null, null);
      throw error;
    }
  }

  private async runEmbedCanonicalMemoryJob(payload: Record<string, unknown>): Promise<void> {
    const canonicalMemoryId = typeof payload.canonicalMemoryId === "string" ? payload.canonicalMemoryId : "";
    if (!canonicalMemoryId) {
      throw new Error("Invalid canonical memory embedding payload");
    }

    const entry = getCanonicalMemoryById(canonicalMemoryId);
    if (!entry) {
      logger.info("memory.canonical_embed.skipped", {
        canonicalMemoryId,
        reason: "missing_entry",
      });
      return;
    }

    if (entry.status !== "active") {
      logger.info("memory.canonical_embed.skipped", {
        canonicalMemoryId,
        reason: "inactive_entry",
        status: entry.status,
      });
      return;
    }

    if (entry.embeddingStatus === "ready" && entry.embeddingModel && entry.embeddingJson) {
      logger.info("memory.canonical_embed.skipped", {
        canonicalMemoryId,
        reason: "already_ready",
        model: entry.embeddingModel,
      });
      return;
    }

    try {
      const result = await createEmbedding(entry.text);
      markCanonicalMemoryEmbedding(
        canonicalMemoryId,
        "ready",
        result.model,
        JSON.stringify(result.embedding),
      );

      logger.info("memory.canonical_embed.completed", {
        canonicalMemoryId,
        model: result.model,
        dimensions: result.embedding.length,
      });
    } catch (error) {
      markCanonicalMemoryEmbedding(canonicalMemoryId, "failed", null, null);
      throw error;
    }
  }

  private async runInvalidateMemoryJob(payload: Record<string, unknown>): Promise<void> {
    const source = typeof payload.source === "string" ? payload.source : "unknown";
    const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    const userText = typeof payload.userText === "string" ? payload.userText : "";

    if (!chatId || !userText) {
      throw new Error("Invalid memory invalidation payload");
    }

    const scope = this.buildPrivateMemoryScopeForChat(source, chatId);
    if (!scope) {
      logger.info("memory.invalidate.skipped", {
        source,
        chatId,
        reason: "non_private_chat",
      });
      return;
    }
    const entries = listMemoryEntriesByScope(scope);
    const decision = await selectMemoriesToInvalidate(this.provider, {
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      userText,
      entries,
    });

    const changed = invalidateMemoryEntries(decision.targetIds);
    if (changed > 0) {
      appendDailyMemoryInvalidation(getWorkdir(), scope, userText);
    }

    logger.info("memory.invalidate.completed", {
      source,
      chatId,
      candidateCount: entries.length,
      targetCount: decision.targetIds.length,
      changed,
    });

    if (changed > 0) {
      enqueuePromotionJob(scope, `${Date.now()}:${changed}`);
    }
  }

  private async runPromoteMemoryScopeJob(payload: Record<string, unknown>): Promise<void> {
    const scope = typeof payload.scope === "string" ? payload.scope as MemoryScope : null;
    if (!scope) {
      throw new Error("Invalid memory promotion payload");
    }

    const dailyEntries = listMemoryEntriesByScope(scope);
    const canonicalEntries = listActiveCanonicalMemoriesByScope(scope);

    const candidates = await promoteCanonicalMemories(this.provider, {
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      dailyEntries,
      canonicalEntries,
    });

    const result = syncCanonicalMemories(
      scope,
      candidates,
      dailyEntries.map((entry) => ({
        id: entry.id,
        text: entry.text,
        status: entry.status,
      })),
    );

    logger.info("memory.promote.completed", {
      scope,
      dailyCount: dailyEntries.length,
      canonicalCandidateCount: candidates.length,
      activeCount: result.activeCount,
      upsertedCount: result.upsertedCount,
      supersededCount: result.supersededCount,
    });

    this.enqueueCanonicalEmbeddingBackfill(scope);
  }

  private enqueueCanonicalEmbeddingBackfill(scope: MemoryScope): void {
    for (const entry of listActiveCanonicalMemoriesByScope(scope)) {
      if (entry.embeddingStatus === "ready" && entry.embeddingModel && entry.embeddingJson) {
        continue;
      }

      enqueueMemoryJob(MEMORY_CANONICAL_EMBED_JOB_KIND, entry.id, {
        canonicalMemoryId: entry.id,
      });
    }
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
    const entries = db.listMemoryEntriesByScope(OWNER_PRIVATE_MEMORY_SCOPE);
    const activeCount = entries.filter((entry) => entry.status === "active").length;
    const rejectedCount = entries.filter((entry) => entry.status === "rejected").length;
    const readyCount = entries.filter((entry) => entry.embeddingStatus === "ready").length;
    const canonicalCount = db.listCanonicalMemoriesByScope(OWNER_PRIVATE_MEMORY_SCOPE)
      .filter((entry) => entry.status === "active")
      .length;
    return [
      "Memory status:",
      `- Scope: ${OWNER_PRIVATE_MEMORY_SCOPE}`,
      `- Active: ${activeCount}`,
      `- Rejected: ${rejectedCount}`,
      `- Canonical: ${canonicalCount}`,
      `- Embedding ready: ${readyCount}`,
      "- Source of truth: structured memory store",
      "- MEMORY.md / PROFILE.md: legacy compatibility only",
    ].join("\n");
  }

  private upsertManualMemory(
    text: string,
    sourceRef: string,
  ): { success: boolean; message: string } {
    const saved = saveExtractedFact(OWNER_PRIVATE_MEMORY_SCOPE, {
      text: text.trim(),
      confidence: 1,
      durability: "long_term_candidate",
      sourceType: "long_term_memory",
      sourceRef,
      lastConfirmedAt: Date.now(),
    });

    appendDailyMemoryFact(getWorkdir(), OWNER_PRIVATE_MEMORY_SCOPE, {
      text: text.trim(),
      confidence: 1,
      durability: "long_term_candidate",
      sourceType: "long_term_memory",
      sourceRef,
      lastConfirmedAt: Date.now(),
    });

    const entry = db.getMemoryEntryById(saved.id);
    if (entry && entry.status === "active" && entry.embeddingStatus !== "ready") {
      enqueueMemoryJob(MEMORY_EMBED_JOB_KIND, saved.id, {
        entryId: saved.id,
      });
    }

    enqueuePromotionJob(OWNER_PRIVATE_MEMORY_SCOPE, `${Date.now()}:${saved.id}`);

    return {
      success: true,
      message: saved.inserted ? `Saved to structured memory: ${text}` : "That memory is already captured.",
    };
  }

  private async rememberMemory(text: string): Promise<{ success: boolean; message: string }> {
    return this.upsertManualMemory(text, "manual:remember");
  }

  private async updateProfile(text: string): Promise<{ success: boolean; message: string }> {
    return this.upsertManualMemory(text, "manual:profile");
  }

  private async compressMemory(): Promise<{ success: boolean; message: string }> {
    return {
      success: false,
      message: "Legacy MEMORY.md compaction is deprecated. Structured memory does not use /compress-memory.",
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

  private async createCodexProbeImage(): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    const dirPath = await mkdtemp(path.join(tmpdir(), "anybot-codex-probe-"));
    const filePath = path.join(dirPath, "probe.png");
    await writeFile(filePath, Buffer.from(CODEX_PROBE_IMAGE_BASE64, "base64"));
    return {
      filePath,
      cleanup: () => rm(dirPath, { recursive: true, force: true }),
    };
  }

  private async runCodexStartupProbeWithRetry<T>(
    probe: "resume" | "image",
    task: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= CODEX_STARTUP_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        const isTimeout = error instanceof ProviderTimeoutError;
        const shouldRetry = isTimeout && attempt < CODEX_STARTUP_RETRY_ATTEMPTS;
        if (!shouldRetry) {
          throw error;
        }

        logger.warn("provider.startup_check.retrying", {
          provider: this.provider.type,
          model: getCurrentModel(),
          probe,
          attempt,
          maxAttempts: CODEX_STARTUP_RETRY_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Unexpected ${probe} startup probe failure`);
  }

  private async runCodexStartupChecks(): Promise<CodexStartupStatus> {
    const passedChecks: string[] = [];
    const checks: CodexStartupStatus["checks"] = {
      text: createPendingCodexCheckStatus(),
      resume: createPendingCodexCheckStatus(),
      image: createPendingCodexCheckStatus(),
    };
    const baseRunOptions = {
      workdir: getWorkdir(),
      sandbox: getSandbox(),
      model: getCurrentModel(),
    };

    try {
      const textToken = `ANYBOT_TEXT_OK_${generateId().slice(0, 8)}`;
      const textResult = await this.provider.run({
        ...baseRunOptions,
        timeoutMs: CODEX_STARTUP_TEXT_TIMEOUT_MS,
        prompt: buildCodexProbePrompt(textToken, "text"),
      });
      if (!isExpectedProbeReply(textResult.text, textToken)) {
        throw new Error("text self-check returned unexpected output");
      }
      checks.text = {
        label: "正常",
        healthy: true,
      };
      passedChecks.push("text");

      if (this.provider.capabilities.sessionResume) {
        if (!textResult.sessionId) {
          throw new Error("text self-check did not return a session id");
        }

        const resumeToken = `ANYBOT_RESUME_OK_${generateId().slice(0, 8)}`;
        const resumeResult = await this.runCodexStartupProbeWithRetry("resume", () => this.provider.run({
          ...baseRunOptions,
          timeoutMs: CODEX_STARTUP_RESUME_TIMEOUT_MS,
          prompt: buildCodexProbePrompt(resumeToken, "resume"),
          sessionId: textResult.sessionId || undefined,
        }));
        if (!isExpectedProbeReply(resumeResult.text, resumeToken)) {
          throw new Error("resume self-check returned unexpected output");
        }
        checks.resume = {
          label: "正常",
          healthy: true,
        };
        passedChecks.push("resume");
      } else {
        checks.resume = {
          label: "跳过",
          healthy: true,
          detail: "provider does not support session resume",
        };
      }

      if (this.provider.capabilities.imageInput) {
        const probeImage = await this.createCodexProbeImage();
        try {
          const imageToken = `ANYBOT_IMAGE_OK_${generateId().slice(0, 8)}`;
          const imageResult = await this.runCodexStartupProbeWithRetry("image", () => this.provider.run({
            ...baseRunOptions,
            timeoutMs: CODEX_STARTUP_IMAGE_TIMEOUT_MS,
            prompt: buildCodexImageProbePrompt(imageToken),
            imagePaths: [probeImage.filePath],
          }));
          if (!isExpectedProbeReply(imageResult.text, imageToken)) {
            throw new Error("image transport self-check returned unexpected output");
          }
          checks.image = {
            label: "正常",
            healthy: true,
          };
          passedChecks.push("image");
        } finally {
          await probeImage.cleanup();
        }
      } else {
        checks.image = {
          label: "跳过",
          healthy: true,
          detail: "provider does not support image input",
        };
      }

      const status: CodexStartupStatus = {
        label: "正常",
        healthy: true,
        checkedAt: Date.now(),
        passedChecks,
        checks,
      };
      this.codexStartupStatus = status;
      logger.info("provider.startup_check.passed", {
        provider: this.provider.type,
        model: getCurrentModel(),
        passedChecks,
      });
      return status;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (checks.text.label === "未检查") {
        checks.text = {
          label: "异常",
          healthy: false,
          detail,
        };
      } else if (checks.resume.label === "未检查" && this.provider.capabilities.sessionResume) {
        checks.resume = {
          label: "异常",
          healthy: false,
          detail,
        };
      } else if (checks.image.label === "未检查" && this.provider.capabilities.imageInput) {
        checks.image = {
          label: "异常",
          healthy: false,
          detail,
        };
      }
      const status: CodexStartupStatus = {
        label: "异常",
        healthy: false,
        checkedAt: Date.now(),
        passedChecks,
        detail,
        checks,
      };
      this.codexStartupStatus = status;
      logger.warn("provider.startup_check.failed", {
        provider: this.provider.type,
        model: getCurrentModel(),
        passedChecks,
        detail,
      });
      return status;
    }
  }

  private buildStartupNotification(
    channels: IChannel[],
    codexStatus: CodexStartupStatus,
  ): string {
    const activeChannels = channels.map((channel) => channel.type).join(", ") || "none";
    const lines = [
      "AnyBot 已上线。",
      `时间：${formatStartupTime(this.startedAt)}`,
      `模型：${getCurrentModel()}`,
      `通道：${activeChannels}`,
      `codex：${codexStatus.label}`,
      `codex文本：${codexStatus.checks.text.label}`,
      `codex续聊：${codexStatus.checks.resume.label}`,
      `codex图片通道：${codexStatus.checks.image.label}`,
    ];

    if (codexStatus.checks.text.label === "异常" && codexStatus.checks.text.detail) {
      lines.push(`codex文本详情：${codexStatus.checks.text.detail}`);
    }
    if (codexStatus.checks.resume.label === "异常" && codexStatus.checks.resume.detail) {
      lines.push(`codex续聊详情：${codexStatus.checks.resume.detail}`);
    }
    if (codexStatus.checks.image.label === "异常" && codexStatus.checks.image.detail) {
      lines.push(`codex图片通道详情：${codexStatus.checks.image.detail}`);
    } else if (!codexStatus.healthy && codexStatus.detail) {
      lines.push(`codex详情：${codexStatus.detail}`);
    }

    return lines.join("\n");
  }

  private async notifyOwnersServiceStarted(
    channels: IChannel[],
    codexStatus: CodexStartupStatus,
  ): Promise<void> {
    if (channels.length === 0) {
      return;
    }

    const message = this.buildStartupNotification(channels, codexStatus);
    await Promise.all(channels.map(async (channel) => {
      try {
        await channel.sendToOwner(message);
        logger.info("service.owner_notified_startup", {
          channel: channel.type,
        });
      } catch (error) {
        logger.warn("service.owner_notify_startup_failed", {
          channel: channel.type,
          error,
        });
      }
    }));
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
    const codexStartupStatus = await this.runCodexStartupChecks();
    logger.info("service.started", {
      activeChannels: channels.map((c) => c.type),
      codexStatus: codexStartupStatus.label,
      codexPassedChecks: codexStartupStatus.passedChecks,
      codexChecks: {
        text: codexStartupStatus.checks.text.label,
        resume: codexStartupStatus.checks.resume.label,
        image: codexStartupStatus.checks.image.label,
      },
      ...(codexStartupStatus.detail ? { codexDetail: codexStartupStatus.detail } : {}),
    });
    await this.notifyOwnersServiceStarted(channels, codexStartupStatus);

    const recoveredJobs = recoverRunningMemoryJobs();
    if (recoveredJobs > 0) {
      logger.warn("memory.jobs.recovered_running", {
        count: recoveredJobs,
      });
    }
    this.memoryWorker.start();
    if (db.listMemoryEntriesByScope(OWNER_PRIVATE_MEMORY_SCOPE).length > 0) {
      enqueuePromotionJob(OWNER_PRIVATE_MEMORY_SCOPE, `startup:${this.startedAt}`);
    }
    this.enqueueCanonicalEmbeddingBackfill(OWNER_PRIVATE_MEMORY_SCOPE);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      logger.info("service.stopping", { reason });

      await channelManager.stopAll();
      await this.memoryWorker.stop();

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

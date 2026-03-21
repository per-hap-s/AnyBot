import { rm } from "node:fs/promises";
import path from "node:path";

import type { IChannel, ChannelCallbacks, TelegramChannelConfig } from "./types.js";
import { readChannelConfig, updateChannelConfig } from "./config.js";
import { logger } from "../logger.js";
import { handleCommand } from "./commands.js";
import {
  isSupportedFeishuDocumentFileName,
  buildUnsupportedFeishuFileMessage,
} from "../message.js";
import {
  answerTelegramCallbackQuery,
  commitTelegramReply,
  deleteTelegramMessage,
  downloadTelegramFile,
  editTelegramMessageText,
  getLargestTelegramPhoto,
  getTelegramUpdates,
  sendTelegramChatAction,
  sendTelegramMessage,
  sendTelegramReply,
  type TelegramCallbackQuery,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate,
} from "../telegram.js";
import {
  ProviderTimeoutError,
  type ProviderRuntimeEvent,
} from "../providers/index.js";
import { ProviderIncompleteReplyError } from "../reply-completion.js";
import {
  cancelTelegramTasksByChat,
  createTelegramAttempt,
  createTelegramTask,
  createTelegramTaskInput,
  getNextTelegramQueueOrder,
  getNextTelegramTaskInputSequence,
  getTelegramAttemptById,
  getTelegramCurrentTaskByChat,
  getTelegramPendingDecisionByChat,
  getTelegramPollState,
  getTelegramTaskById,
  listRecoverableTelegramTasks,
  listRunnableTelegramTasks,
  listTelegramTaskInputs,
  listTelegramTaskInputsUpToRevision,
  resetRecoverableTelegramAttempts,
  saveTelegramMessageRef,
  saveTelegramPollState,
  type TelegramAttempt,
  type TelegramTask,
  type TelegramTaskInput,
  type TelegramTaskInputKind,
  updateTelegramAttempt,
  updateTelegramTask,
  findTelegramMessageRef,
} from "../web/db.js";
import {
  buildTelegramImageStatus,
  getTelegramStatusPhaseRank,
  mapProviderEventToTelegramStatus,
  TELEGRAM_RECEIVED_STATUS_TEXT,
  TELEGRAM_SENDING_STATUS_TEXT,
  TELEGRAM_STATUS_UPDATE_THROTTLE_MS,
} from "./telegram-status.js";
import { TelegramRouterClient } from "./telegram-router.js";

const MAX_HANDLED_UPDATE_IDS = 5000;
const CHAT_ACTION_REFRESH_MS = 4000;
const POLL_STATE_CHANNEL = "telegram";
const CALLBACK_PREFIX = "tgd";
const MERGE_WINDOW_MS = 3_000;
const EARLY_RUNNING_MS = 10_000;
const WORKER_POLL_MS = 1_000;
const ROUTER_AUTO_CONFIDENCE = 0.85;

const SUPPLEMENT_APPLIED_TEXT = "已加入当前任务";
const SUPPLEMENT_NEXT_ATTEMPT_TEXT = "已加入当前任务的下一轮";
const QUEUED_STATUS_TEXT = "已加入队列";
const DECISION_PROMPT_TEXT = "收到新消息，要补充当前任务还是排队？";
const STALE_DECISION_TEXT = "这个选择已经失效了";
const TELEGRAM_IDLE_TIMEOUT_ERROR_TEXT = "本次任务因长时间无进展而超时，请稍后重试。";
const TELEGRAM_MAX_RUNTIME_ERROR_TEXT = "本次任务已达到最长运行时长（60 分钟），请拆分任务后重试。";
const TELEGRAM_GENERIC_ERROR_TEXT = "处理消息时出错了，请稍后再试。";

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StatusMessageTransport = {
  send: typeof sendTelegramMessage;
  edit: typeof editTelegramMessageText;
  delete: typeof deleteTelegramMessage;
};

const defaultStatusMessageTransport: StatusMessageTransport = {
  send: sendTelegramMessage,
  edit: editTelegramMessageText,
  delete: deleteTelegramMessage,
};

type TelegramChannelDeps = {
  getUpdates: typeof getTelegramUpdates;
  sendMessage: typeof sendTelegramMessage;
  editMessageText: typeof editTelegramMessageText;
  deleteMessage: typeof deleteTelegramMessage;
  commitReply: typeof commitTelegramReply;
  sendChatAction: typeof sendTelegramChatAction;
  updateChannelConfig: typeof updateChannelConfig;
};

const defaultTelegramChannelDeps: TelegramChannelDeps = {
  getUpdates: getTelegramUpdates,
  sendMessage: sendTelegramMessage,
  editMessageText: editTelegramMessageText,
  deleteMessage: deleteTelegramMessage,
  commitReply: commitTelegramReply,
  sendChatAction: sendTelegramChatAction,
  updateChannelConfig,
};

interface LiveDecision {
  taskId: string;
  status: StatusMessageController;
}

interface LiveRunningTask {
  taskId: string;
  attemptId: string;
  status: StatusMessageController;
  abortController: AbortController;
  runtimeStatusTracker: TelegramRuntimeStatusTracker;
}

interface ChatState {
  running: LiveRunningTask | null;
  decision: LiveDecision | null;
}

class CappedSet<T> {
  private set = new Set<T>();
  private queue: T[] = [];

  constructor(private readonly capacity: number) {}

  has(value: T): boolean {
    return this.set.has(value);
  }

  add(value: T): void {
    if (this.set.has(value)) {
      return;
    }
    if (this.set.size >= this.capacity) {
      const oldest = this.queue.shift();
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
    this.set.add(value);
    this.queue.push(value);
  }
}

export class StatusMessageController {
  private statusMessage: TelegramMessage | null = null;
  private currentText: string | null = null;
  private currentReplyMarkupKey: string | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private sealed = false;

  constructor(
    private readonly botToken: string,
    private readonly chatId: number,
    private readonly replyToMessageId?: number,
    private readonly transport: StatusMessageTransport = defaultStatusMessageTransport,
  ) {}

  get messageId(): number | null {
    return this.statusMessage?.message_id || null;
  }

  get currentMessage(): TelegramMessage | null {
    return this.statusMessage;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  seedExisting(message: TelegramMessage): void {
    this.statusMessage = message;
  }

  async show(
    text: string,
    opts?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
      clearKeyboard?: boolean;
    },
  ): Promise<void> {
    const replyMarkup = opts?.clearKeyboard ? { inline_keyboard: [] } : opts?.replyMarkup;
    const replyMarkupKey = JSON.stringify(replyMarkup ?? null);

    if (this.sealed) {
      return;
    }

    this.operationQueue = this.operationQueue.catch(() => {}).then(async () => {
      if (this.sealed) {
        return;
      }
      if (this.currentText === text && this.currentReplyMarkupKey === replyMarkupKey) {
        return;
      }

      if (!this.statusMessage) {
        this.statusMessage = await this.transport.send(this.botToken, this.chatId, text, {
          replyToMessageId: this.replyToMessageId,
          replyMarkup,
        });
      } else {
        await this.transport.edit(
          this.botToken,
          this.chatId,
          this.statusMessage.message_id,
          text,
          replyMarkup ? { replyMarkup } : undefined,
        );
      }

      this.currentText = text;
      this.currentReplyMarkupKey = replyMarkupKey;
    });

    return this.operationQueue;
  }

  async delete(): Promise<void> {
    this.sealed = true;
    await this.operationQueue.catch(() => {});
    if (!this.statusMessage) {
      return;
    }

    try {
      await this.transport.delete(this.botToken, this.chatId, this.statusMessage.message_id);
    } catch (error) {
      logger.warn("telegram.status.delete_failed", {
        chatId: this.chatId,
        messageId: this.statusMessage.message_id,
        error,
      });
    } finally {
      this.statusMessage = null;
      this.currentText = null;
      this.currentReplyMarkupKey = null;
    }
  }
}

type RuntimeStatusTarget = Pick<StatusMessageController, "show">;

export class TelegramRuntimeStatusTracker {
  private currentPhase: number = getTelegramStatusPhaseRank("received");
  private currentText: string | null = null;
  private lastRenderedAt = 0;
  private pendingStatus: { phaseRank: number; text: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private disposed = false;
  private stickyPreProcessingText: string | null = null;

  constructor(
    private readonly status: RuntimeStatusTarget,
    private readonly isActive: () => boolean,
    private readonly throttleMs: number = TELEGRAM_STATUS_UPDATE_THROTTLE_MS,
  ) {}

  prime(text: string): void {
    if (this.disposed) {
      return;
    }
    this.currentPhase = getTelegramStatusPhaseRank("received");
    this.currentText = text;
    this.lastRenderedAt = Date.now();
  }

  handleProviderEvent(event: ProviderRuntimeEvent): void {
    const nextStatus = mapProviderEventToTelegramStatus(event);
    if (!nextStatus || this.isStopped()) {
      return;
    }

    if (
      this.stickyPreProcessingText
      && (event.type === "thread.started" || event.type === "turn.started")
    ) {
      return;
    }

    this.stickyPreProcessingText = null;
    this.enqueue(nextStatus.text, getTelegramStatusPhaseRank(nextStatus.phase));
  }

  async showImageUnderstanding(): Promise<void> {
    const nextStatus = buildTelegramImageStatus();
    this.stickyPreProcessingText = nextStatus.text;
    await this.showImmediate(nextStatus.text, getTelegramStatusPhaseRank(nextStatus.phase));
  }

  async showSending(): Promise<void> {
    this.stickyPreProcessingText = null;
    await this.showImmediate(TELEGRAM_SENDING_STATUS_TEXT, getTelegramStatusPhaseRank("sending"));
  }

  dispose(): void {
    this.disposed = true;
    this.clearPendingState();
  }

  private enqueue(text: string, phaseRank: number): void {
    if (phaseRank < this.currentPhase) {
      return;
    }
    if (phaseRank === this.currentPhase && text === this.currentText) {
      return;
    }

    this.pendingStatus = { phaseRank, text };
    this.schedule();
  }

  private schedule(): void {
    if (!this.pendingStatus || this.isStopped()) {
      return;
    }
    if (this.flushPromise) {
      return;
    }

    const waitMs = Math.max(0, this.throttleMs - (Date.now() - this.lastRenderedAt));
    if (waitMs === 0) {
      this.flushPending();
      return;
    }
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
    }, waitMs);
  }

  private async showImmediate(text: string, phaseRank: number): Promise<void> {
    if (phaseRank < this.currentPhase || this.isStopped()) {
      return;
    }
    if (phaseRank === this.currentPhase && text === this.currentText) {
      return;
    }

    this.clearPendingState();
    await this.render(text, phaseRank);
  }

  private flushPending(): void {
    if (!this.pendingStatus || this.isStopped()) {
      return;
    }

    const pendingStatus = this.pendingStatus;
    this.pendingStatus = null;
    this.flushPromise = this.render(pendingStatus.text, pendingStatus.phaseRank)
      .catch((error) => {
        logger.warn("telegram.status.runtime_update_failed", { error });
      })
      .finally(() => {
        this.flushPromise = null;
        if (this.pendingStatus && !this.disposed) {
          this.schedule();
        }
      });
  }

  private async render(text: string, phaseRank: number): Promise<void> {
    if (this.isStopped()) {
      return;
    }

    await this.status.show(text);
    if (this.isStopped()) {
      return;
    }
    this.currentPhase = Math.max(this.currentPhase, phaseRank);
    this.currentText = text;
    this.lastRenderedAt = Date.now();
  }

  private clearPendingState(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingStatus = null;
  }

  private isStopped(): boolean {
    return this.disposed || !this.isActive();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateMessage(message: TelegramMessage): boolean {
  return message.chat.type === "private";
}

function getMessageText(message: Pick<TelegramMessage, "text" | "caption">): string {
  return (message.text || message.caption || "").trim();
}

function truncateTelegramContext(text: string, maxLength: number = 1200): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function describeTelegramMedia(
  message: Pick<TelegramMessage, "text" | "caption" | "photo" | "document">,
): string {
  const text = getMessageText(message);
  if (text) {
    return text;
  }
  if (message.document?.file_name) {
    return `[Document] ${message.document.file_name}`;
  }
  if (message.document) {
    return "[Document]";
  }
  if (message.photo?.length) {
    return "[Photo]";
  }
  return "[Unsupported Telegram message]";
}

function getTelegramMessageRole(
  message?: { from?: TelegramMessage["from"] } | null,
): "user" | "assistant" | "unknown" {
  if (!message?.from) {
    return "unknown";
  }
  return message.from.is_bot ? "assistant" : "user";
}

function buildTelegramReplyContext(message: TelegramMessage): string {
  const lines: string[] = [];
  const replyToMessageId = message.reply_to_message?.message_id;
  const storedReply = typeof replyToMessageId === "number"
    ? findTelegramMessageRef(String(message.chat.id), replyToMessageId)
    : null;
  const replyRole = storedReply?.role || getTelegramMessageRole(message.reply_to_message);
  const replyContent = storedReply?.content
    || (message.reply_to_message ? describeTelegramMedia(message.reply_to_message) : null);
  const quoteText = message.quote?.text?.trim();
  const externalContent = message.external_reply
    ? describeTelegramMedia(message.external_reply)
    : null;
  const externalQuote = message.external_reply?.quote?.text?.trim() || null;
  const externalRole = getTelegramMessageRole(message.external_reply);

  if (replyContent) {
    lines.push("Telegram reply context:");
    lines.push(`- The user replied to a previous ${replyRole} message.`);
    lines.push(`- Replied Telegram message id: ${replyToMessageId}`);
    lines.push("- Replied message content:");
    lines.push(truncateTelegramContext(replyContent));
  }

  if (quoteText) {
    if (lines.length === 0) {
      lines.push("Telegram reply context:");
    }
    lines.push("- The user highlighted this quoted fragment:");
    lines.push(truncateTelegramContext(quoteText, 400));
  }

  if (externalContent) {
    if (lines.length === 0) {
      lines.push("Telegram reply context:");
    }
    lines.push(`- The user also referenced an external ${externalRole} message.`);
    lines.push("- External referenced content:");
    lines.push(truncateTelegramContext(externalContent));
  }

  if (externalQuote) {
    if (lines.length === 0) {
      lines.push("Telegram reply context:");
    }
    lines.push("- External quoted fragment:");
    lines.push(truncateTelegramContext(externalQuote, 400));
  }

  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

function buildTelegramUserPrompt(message: TelegramMessage, baseText: string): string {
  return `${buildTelegramReplyContext(message)}${baseText}`.trim();
}

function buildDecisionKeyboard(taskId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "补充", callback_data: `${CALLBACK_PREFIX}:supplement:${taskId}` },
      { text: "排队", callback_data: `${CALLBACK_PREFIX}:queue:${taskId}` },
    ]],
  };
}

function parseDecisionCallback(data?: string): { action: "supplement" | "queue"; taskId: string } | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }
  if (parts[1] !== "supplement" && parts[1] !== "queue") {
    return null;
  }
  return {
    action: parts[1],
    taskId: parts[2],
  };
}

function createPlaceholderTelegramMessage(chatId: string, messageId: number): TelegramMessage {
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(chatId),
      type: "private",
    },
  } as TelegramMessage;
}

function isResetCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "/new" || trimmed === "/reset" || trimmed === "/start";
}

function shouldAutoMergeCurrentTask(task: TelegramTask): boolean {
  return task.currentPhase === "merge_window"
    && task.status === "queued"
    && Date.now() - task.updatedAt < MERGE_WINDOW_MS;
}

function buildTaskSummary(taskInputs: TelegramTaskInput[]): string {
  return taskInputs
    .slice(-3)
    .map((input) => input.text || "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 800);
}

function startTypingIndicatorLoop(
  botToken: string,
  chatId: string,
  isActive: () => boolean,
  sendChatAction: typeof sendTelegramChatAction,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    if (stopped || !isActive()) {
      return;
    }

    void sendChatAction(botToken, chatId, "typing").catch((error) => {
      logger.warn("telegram.chat_action_failed", {
        chatId,
        action: "typing",
        error,
      });
    }).finally(() => {
      if (stopped || !isActive()) {
        return;
      }
      timer = setTimeout(tick, CHAT_ACTION_REFRESH_MS);
    });
  };

  tick();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function getTelegramBatchFailureText(error: unknown): string {
  if (error instanceof ProviderIncompleteReplyError) {
    return "这次查询没有拿到结果，也没有明确失败原因，请稍后重试。";
  }
  if (error instanceof ProviderTimeoutError) {
    if (error.kind === "idle") {
      return TELEGRAM_IDLE_TIMEOUT_ERROR_TEXT;
    }
    if (error.kind === "max_runtime") {
      return TELEGRAM_MAX_RUNTIME_ERROR_TEXT;
    }
  }
  return TELEGRAM_GENERIC_ERROR_TEXT;
}

export async function cleanupTelegramChatState(state: ChatState): Promise<void> {
  const cleanupTasks: Promise<void>[] = [];

  if (state.decision) {
    cleanupTasks.push(state.decision.status.delete());
    state.decision = null;
  }

  if (state.running) {
    state.running.runtimeStatusTracker.dispose();
    state.running.abortController.abort();
    cleanupTasks.push(state.running.status.delete());
    state.running = null;
  }

  if (cleanupTasks.length > 0) {
    await Promise.allSettled(cleanupTasks);
  }
}

export class TelegramChannel implements IChannel {
  readonly type = "telegram";

  private config: TelegramChannelConfig | null = null;
  private callbacks: ChannelCallbacks | null = null;
  private handledUpdateIds = new CappedSet<number>(MAX_HANDLED_UPDATE_IDS);
  private running = false;
  private pollLoopPromise: Promise<void> | null = null;
  private pollAbortController: AbortController | null = null;
  private workerTimer: NodeJS.Timeout | null = null;
  private workerRunning = false;
  private offset: number | null = null;
  private readonly workdir = process.env.CODEX_WORKDIR || process.cwd();
  private readonly chatStates = new Map<string, ChatState>();
  private readonly router = new TelegramRouterClient();
  private readonly deps: TelegramChannelDeps;

  constructor(deps: Partial<TelegramChannelDeps> = {}) {
    this.deps = {
      ...defaultTelegramChannelDeps,
      ...deps,
    };
  }

  async start(callbacks: ChannelCallbacks): Promise<void> {
    const config = readChannelConfig<TelegramChannelConfig>("telegram");
    if (!config || !config.enabled) {
      logger.info("telegram.skipped", { reason: "disabled or missing config" });
      return;
    }
    if (!config.botToken) {
      logger.warn("telegram.skipped", { reason: "missing botToken" });
      return;
    }

    this.config = config;
    this.callbacks = callbacks;
    this.running = true;

    this.hydrateOffset();
    this.recoverPersistedTelegramTasks();
    this.workerTimer = setInterval(() => {
      void this.tickWorker();
    }, WORKER_POLL_MS);
    this.pollLoopPromise = this.pollLoop();
    logger.info("telegram.started", {
      privateOnly: config.privateOnly,
      allowGroups: config.allowGroups,
      pollingTimeoutSeconds: config.pollingTimeoutSeconds,
      routerEnabled: this.router.isEnabled(),
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }

    try {
      await this.pollLoopPromise;
    } catch {
      // Ignore polling shutdown errors.
    }

    for (const state of this.chatStates.values()) {
      if (state.running) {
        state.running.runtimeStatusTracker.dispose();
        state.running.abortController.abort();
        state.running = null;
      }
      state.decision = null;
    }

    this.chatStates.clear();
    this.pollLoopPromise = null;
    this.config = null;
    this.callbacks = null;
    logger.info("telegram.stopped");
  }

  async sendToOwner(text: string): Promise<void> {
    if (!this.config?.botToken) {
      throw new Error("Telegram channel is not started");
    }
    if (!this.config.ownerChatId) {
      throw new Error("Telegram ownerChatId 未配置，请先私聊机器人一次，或在设置中手动填写");
    }
    await sendTelegramReply(this.config.botToken, this.config.ownerChatId, text, this.workdir);
  }

  private getChatState(chatId: string): ChatState {
    let state = this.chatStates.get(chatId);
    if (!state) {
      state = {
        running: null,
        decision: null,
      };
      this.chatStates.set(chatId, state);
    }
    return state;
  }

  private hydrateOffset(): void {
    const saved = getTelegramPollState(POLL_STATE_CHANNEL);
    this.offset = saved ? saved.lastUpdateId + 1 : null;
  }

  private recoverPersistedTelegramTasks(): void {
    const now = Date.now();
    resetRecoverableTelegramAttempts(now);
    for (const task of listRecoverableTelegramTasks()) {
      if (task.status === "running" || task.status === "waiting_next_attempt") {
        updateTelegramTask({
          ...task,
          status: "queued",
          activeAttemptId: null,
          cancelRequestedAt: null,
          updatedAt: now,
        });
      }
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running && this.config?.botToken) {
      this.pollAbortController = new AbortController();

      try {
        await this.pollOnce(this.pollAbortController.signal);
      } catch (error) {
        if (!this.running) {
          break;
        }
        if ((error as Error).name === "AbortError") {
          continue;
        }

        logger.error("telegram.poll.failed", { error });
        await delay(2000);
      } finally {
        this.pollAbortController = null;
      }
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const updates = await this.deps.getUpdates(
      this.config!.botToken,
      this.offset,
      this.config!.pollingTimeoutSeconds,
      signal,
    );

    for (const update of updates) {
      await this.handleUpdate(update);
      this.offset = update.update_id + 1;
      saveTelegramPollState({
        channel: POLL_STATE_CHANNEL,
        lastUpdateId: update.update_id,
        updatedAt: Date.now(),
      });
    }
  }

  private async tickWorker(): Promise<void> {
    if (!this.running || this.workerRunning || !this.config || !this.callbacks) {
      return;
    }

    this.workerRunning = true;
    try {
      const tasks = listRunnableTelegramTasks();
      for (const task of tasks) {
        if (!this.running) {
          return;
        }
        const state = this.getChatState(task.chatId);
        if (state.running) {
          continue;
        }
        if (task.currentPhase === "merge_window" && Date.now() - task.updatedAt < MERGE_WINDOW_MS) {
          continue;
        }
        try {
          await this.startTaskAttempt(task, state);
        } catch (error) {
          logger.error("telegram.task_attempt.start_failed", {
            taskId: task.id,
            chatId: task.chatId,
            error,
          });
        }
      }
    } finally {
      this.workerRunning = false;
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.handledUpdateIds.has(update.update_id)) {
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      this.handledUpdateIds.add(update.update_id);
      return;
    }
    if (!update.message) {
      this.handledUpdateIds.add(update.update_id);
      return;
    }

    const message = update.message;
    const config = this.config!;

    if (config.privateOnly && !isPrivateMessage(message)) {
      this.handledUpdateIds.add(update.update_id);
      return;
    }
    if (!config.allowGroups && message.chat.type !== "private") {
      this.handledUpdateIds.add(update.update_id);
      return;
    }

    if (isPrivateMessage(message) && !config.ownerChatId) {
      config.ownerChatId = String(message.chat.id);
      this.deps.updateChannelConfig("telegram", { ownerChatId: config.ownerChatId });
    }

    persistTelegramInboundMessage(message);

    if (message.document && !isSupportedFeishuDocumentFileName(message.document.file_name || "unknown")) {
      await this.deps.sendMessage(config.botToken, message.chat.id, buildUnsupportedFeishuFileMessage(
        message.document.file_name || "unknown",
      ));
      this.handledUpdateIds.add(update.update_id);
      return;
    }

    await this.handleIncomingMessage(message);
    this.handledUpdateIds.add(update.update_id);
  }

  private async handleIncomingMessage(message: TelegramMessage): Promise<void> {
    const botToken = this.config!.botToken;
    const chatId = String(message.chat.id);
    const userText = getMessageText(message);
    const state = this.getChatState(chatId);

    if (!message.photo?.length && !message.document && !userText) {
      await this.deps.sendMessage(botToken, message.chat.id, "请直接发送文字问题。");
      return;
    }

    if (userText) {
      const cmd = await handleCommand(userText, chatId, "telegram", this.callbacks!);
      if (cmd.handled) {
        if (isResetCommand(userText)) {
          await this.resetChatState(chatId, state);
        }
        if (cmd.reply) {
          await this.deps.sendMessage(botToken, message.chat.id, cmd.reply);
        }
        return;
      }
    }

    const currentTask = getTelegramCurrentTaskByChat(chatId);
    const decisionTask = getTelegramPendingDecisionByChat(chatId);

    if (!currentTask) {
      const task = this.createStandaloneTask(message);
      await this.attachInputToTask(task.id, task.currentRevision, message);
      await this.ensureTaskStatusMessage(task, message.message_id, TELEGRAM_RECEIVED_STATUS_TEXT);
      return;
    }

    if (shouldAutoMergeCurrentTask(currentTask)) {
      await this.attachInputToTask(currentTask.id, currentTask.currentRevision, message);
      updateTelegramTask({
        ...currentTask,
        updatedAt: Date.now(),
      });
      await this.ensureTaskStatusMessage(currentTask, message.message_id, TELEGRAM_RECEIVED_STATUS_TEXT);
      return;
    }

    if (decisionTask) {
      await this.attachInputToTask(decisionTask.id, decisionTask.currentRevision, message);
      await this.showDecisionTask(decisionTask.id, message.message_id);
      return;
    }

    const newDecisionTask = this.createDecisionTask(chatId);
    await this.attachInputToTask(newDecisionTask.id, newDecisionTask.currentRevision, message);
    await this.showDecisionTask(newDecisionTask.id, message.message_id);
    void this.maybeAutoResolveDecision(newDecisionTask.id, currentTask.id);
  }

  private createStandaloneTask(message: TelegramMessage): TelegramTask {
    const now = Date.now();
    const chatId = String(message.chat.id);
    const task: TelegramTask = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      status: "queued",
      queueOrder: getNextTelegramQueueOrder(chatId),
      currentRevision: 1,
      activeAttemptId: null,
      providerSessionId: null,
      latestStatusMessageId: null,
      latestResultMessageId: null,
      decisionStatus: null,
      decisionDeadlineAt: null,
      currentPhase: "merge_window",
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    createTelegramTask(task);
    return task;
  }

  private createDecisionTask(chatId: string): TelegramTask {
    const now = Date.now();
    const task: TelegramTask = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      status: "decision_pending",
      queueOrder: getNextTelegramQueueOrder(chatId),
      currentRevision: 1,
      activeAttemptId: null,
      providerSessionId: null,
      latestStatusMessageId: null,
      latestResultMessageId: null,
      decisionStatus: "pending",
      decisionDeadlineAt: null,
      currentPhase: "merge_window",
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    createTelegramTask(task);
    return task;
  }

  private async attachInputToTask(taskId: string, revision: number, message: TelegramMessage): Promise<void> {
    const sequence = getNextTelegramTaskInputSequence(taskId);
    createTelegramTaskInput(this.buildTaskInput(taskId, revision, sequence, message));
  }

  private buildTaskInput(
    taskId: string,
    revision: number,
    sequence: number,
    message: TelegramMessage,
  ): TelegramTaskInput {
    const text = getMessageText(message);
    const photo = message.photo?.length ? getLargestTelegramPhoto(message.photo) : null;
    const attachmentJson = photo
      ? JSON.stringify({ fileId: photo.file_id, fileName: "telegram-photo.jpg" })
      : message.document?.file_id
        ? JSON.stringify({
            fileId: message.document.file_id,
            fileName: message.document.file_name || "telegram-document",
          })
        : null;
    const kind: TelegramTaskInputKind = photo
      ? "photo"
      : message.document?.file_id
        ? "document"
        : "text";

    const promptText = kind === "text"
      ? buildTelegramUserPrompt(message, text)
      : kind === "photo"
        ? buildTelegramUserPrompt(message, text || "用户发来了一张图片。请根据图片内容直接回答。")
        : buildTelegramUserPrompt(message, text || "用户发来了一份文件，请优先读取并理解它，再回答用户问题。");

    return {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      revision,
      sequence,
      kind,
      telegramMessageId: message.message_id,
      text: promptText,
      attachmentJson,
      createdAt: Date.now(),
    };
  }

  private async showDecisionTask(taskId: string, anchorMessageId: number): Promise<void> {
    const task = getTelegramTaskById(taskId);
    if (!task || task.status !== "decision_pending") {
      return;
    }

    const status = this.getDecisionStatusController(task, anchorMessageId);
    const items = listTelegramTaskInputs(task.id);
    await status.show(
      items.length > 1 ? `收到 ${items.length} 条新消息，要补充当前任务还是排队？` : DECISION_PROMPT_TEXT,
      { replyMarkup: buildDecisionKeyboard(task.id) },
    );
    updateTelegramTask({
      ...task,
      latestStatusMessageId: status.messageId,
      updatedAt: Date.now(),
    });
  }

  private getDecisionStatusController(task: TelegramTask, anchorMessageId: number): StatusMessageController {
    const state = this.getChatState(task.chatId);
    if (state.decision?.taskId === task.id) {
      return state.decision.status;
    }

    const status = this.createStatusController(task.chatId, anchorMessageId);
    if (task.latestStatusMessageId) {
      status.seedExisting(createPlaceholderTelegramMessage(task.chatId, task.latestStatusMessageId));
    }
    state.decision = { taskId: task.id, status };
    return status;
  }

  private getResolvableDecisionStatusController(
    task: TelegramTask,
    anchorMessageId?: number,
  ): StatusMessageController | null {
    const state = this.getChatState(task.chatId);
    if (state.decision?.taskId === task.id) {
      return state.decision.status;
    }
    if (!task.latestStatusMessageId && anchorMessageId === undefined) {
      return null;
    }

    const status = this.createStatusController(
      task.chatId,
      anchorMessageId ?? task.latestStatusMessageId ?? 0,
    );
    if (task.latestStatusMessageId) {
      status.seedExisting(createPlaceholderTelegramMessage(task.chatId, task.latestStatusMessageId));
    }
    state.decision = { taskId: task.id, status };
    return status;
  }

  private async tryUpdateResolvedDecisionMessage(
    task: TelegramTask,
    text: string,
    anchorMessageId?: number,
  ): Promise<void> {
    const state = this.getChatState(task.chatId);
    const status = this.getResolvableDecisionStatusController(task, anchorMessageId);
    if (!status) {
      state.decision = null;
      return;
    }

    try {
      await status.show(text, { clearKeyboard: true });
    } catch (error) {
      logger.warn("telegram.decision.resolve_message_failed", {
        taskId: task.id,
        chatId: task.chatId,
        error,
      });
    } finally {
      state.decision = null;
    }
  }

  private async maybeAutoResolveDecision(decisionTaskId: string, currentTaskId: string): Promise<void> {
    const decisionTask = getTelegramTaskById(decisionTaskId);
    const currentTask = getTelegramTaskById(currentTaskId);
    if (!decisionTask || !currentTask || decisionTask.status !== "decision_pending") {
      return;
    }

    const decisionInputs = listTelegramTaskInputs(decisionTask.id).map((item) => item.text || "");
    const currentInputs = listTelegramTaskInputsUpToRevision(currentTask.id, currentTask.currentRevision);
    const routing = await this.router.classify({
      currentTaskSummary: buildTaskSummary(currentInputs),
      currentPhase: currentTask.currentPhase,
      recentUserMessages: currentInputs.slice(-2).map((item) => item.text || ""),
      incomingMessages: decisionInputs,
    });
    if (routing.confidence < ROUTER_AUTO_CONFIDENCE || routing.intentType === "unclear") {
      return;
    }

    await this.resolveDecisionTask(decisionTask.id, routing.intentType);
  }

  private async handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const parsed = parseDecisionCallback(callbackQuery.data);
    if (!parsed || !callbackQuery.message || !callbackQuery.message.chat) {
      await answerTelegramCallbackQuery(this.config!.botToken, callbackQuery.id, {
        text: STALE_DECISION_TEXT,
      }).catch(() => {});
      return;
    }

    const task = getTelegramTaskById(parsed.taskId);
    if (!task || task.status !== "decision_pending") {
      await answerTelegramCallbackQuery(this.config!.botToken, callbackQuery.id, {
        text: STALE_DECISION_TEXT,
      }).catch(() => {});
      return;
    }

    await answerTelegramCallbackQuery(this.config!.botToken, callbackQuery.id).catch(() => {});
    await this.resolveDecisionTask(task.id, parsed.action, callbackQuery.message.message_id);
  }

  private async resolveDecisionTask(
    taskId: string,
    action: "supplement" | "queue",
    anchorMessageId?: number,
  ): Promise<void> {
    const decisionTask = getTelegramTaskById(taskId);
    if (!decisionTask || decisionTask.status !== "decision_pending") {
      return;
    }

    const state = this.getChatState(decisionTask.chatId);
    const currentTask = getTelegramCurrentTaskByChat(decisionTask.chatId);
    if (!currentTask || action === "queue") {
      updateTelegramTask({
        ...decisionTask,
        status: "queued",
        decisionStatus: "resolved",
        updatedAt: Date.now(),
      });
      await this.tryUpdateResolvedDecisionMessage(decisionTask, QUEUED_STATUS_TEXT, anchorMessageId);
      return;
    }

    const inputs = listTelegramTaskInputs(decisionTask.id);
    const activeAttempt = currentTask.activeAttemptId ? getTelegramAttemptById(currentTask.activeAttemptId) : null;
    const canRestart = (currentTask.currentPhase === "starting" || currentTask.currentPhase === "early_running")
      && !activeAttempt?.hasLongStep;
    const nextRevision = currentTask.currentRevision + 1;
    const now = Date.now();

    for (const input of inputs) {
      createTelegramTaskInput({
        ...input,
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        taskId: currentTask.id,
        revision: nextRevision,
        sequence: getNextTelegramTaskInputSequence(currentTask.id),
        createdAt: now,
      });
    }

    updateTelegramTask({
      ...currentTask,
      currentRevision: nextRevision,
      status: canRestart ? "running" : "waiting_next_attempt",
      cancelRequestedAt: canRestart ? now : null,
      currentPhase: canRestart ? "starting" : currentTask.currentPhase,
      updatedAt: now,
    });
    updateTelegramTask({
      ...decisionTask,
      status: "cancelled",
      decisionStatus: "resolved",
      updatedAt: now,
    });

    await this.tryUpdateResolvedDecisionMessage(
      decisionTask,
      canRestart ? SUPPLEMENT_APPLIED_TEXT : SUPPLEMENT_NEXT_ATTEMPT_TEXT,
      anchorMessageId,
    );

    if (canRestart && state.running?.taskId === currentTask.id) {
      state.running.abortController.abort();
    }
  }

  private async startTaskAttempt(task: TelegramTask, state: ChatState): Promise<void> {
    const inputs = listTelegramTaskInputsUpToRevision(task.id, task.currentRevision);
    if (inputs.length === 0) {
      return;
    }

    const attemptId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const attempt: TelegramAttempt = {
      id: attemptId,
      taskId: task.id,
      revision: task.currentRevision,
      status: "running",
      inputSnapshotJson: JSON.stringify(inputs),
      providerSessionIdBefore: task.providerSessionId,
      providerSessionIdAfter: null,
      hasLongStep: false,
      lastEventAt: null,
      timeoutKind: null,
      resultText: null,
      errorText: null,
      startedAt: Date.now(),
      finishedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createTelegramAttempt(attempt);

    task.status = "running";
    task.activeAttemptId = attempt.id;
    task.currentPhase = "starting";
    task.updatedAt = Date.now();
    updateTelegramTask(task);

    try {
      const status = this.createStatusController(task.chatId, inputs[inputs.length - 1]!.telegramMessageId);
      if (task.latestStatusMessageId) {
        status.seedExisting(createPlaceholderTelegramMessage(task.chatId, task.latestStatusMessageId));
      }
      await status.show(TELEGRAM_RECEIVED_STATUS_TEXT, { clearKeyboard: true });
      task.latestStatusMessageId = status.messageId;
      updateTelegramTask(task);

      const abortController = new AbortController();
      const runtimeStatusTracker = new TelegramRuntimeStatusTracker(
        status,
        () => this.running && this.getChatState(task.chatId).running?.attemptId === attempt.id,
      );
      state.running = {
        taskId: task.id,
        attemptId: attempt.id,
        status,
        abortController,
        runtimeStatusTracker,
      };

      void this.executeTaskAttempt(task.id, attempt.id, status, runtimeStatusTracker, abortController.signal).catch((error) => {
        logger.error("telegram.task_attempt.unhandled_failure", {
          taskId: task.id,
          attemptId: attempt.id,
          error,
        });
      });
    } catch (error) {
      this.failTaskAttemptBeforeExecution(task.id, attempt.id, error);
      throw error;
    }
  }

  private failTaskAttemptBeforeExecution(taskId: string, attemptId: string, error: unknown): void {
    const task = getTelegramTaskById(taskId);
    const attempt = getTelegramAttemptById(attemptId);
    const now = Date.now();

    if (attempt) {
      updateTelegramAttempt({
        ...attempt,
        status: "failed",
        errorText: toErrorText(error),
        finishedAt: now,
        updatedAt: now,
      });
    }

    if (task && task.activeAttemptId === attemptId) {
      updateTelegramTask({
        ...task,
        activeAttemptId: null,
        cancelRequestedAt: null,
        status: "failed",
        updatedAt: now,
      });
    }

    const state = task ? this.getChatState(task.chatId) : null;
    if (state?.running?.attemptId === attemptId) {
      state.running = null;
    }
  }

  private async executeTaskAttempt(
    taskId: string,
    attemptId: string,
    status: StatusMessageController,
    runtimeStatusTracker: TelegramRuntimeStatusTracker,
    signal: AbortSignal,
  ): Promise<void> {
    const task = getTelegramTaskById(taskId);
    const attempt = getTelegramAttemptById(attemptId);
    if (!task || !attempt) {
      return;
    }

    const cleanupDirs = new Set<string>();
    const stopTypingIndicator = startTypingIndicatorLoop(
      this.config!.botToken,
      task.chatId,
      () => this.getChatState(task.chatId).running?.attemptId === attemptId && !signal.aborted,
      this.deps.sendChatAction,
    );
    const stableTimer = setTimeout(() => {
      const latestTask = getTelegramTaskById(taskId);
      if (!latestTask || latestTask.activeAttemptId !== attemptId) {
        return;
      }
      updateTelegramTask({
        ...latestTask,
        currentPhase: "stable_running",
        updatedAt: Date.now(),
      });
    }, EARLY_RUNNING_MS);

    try {
      runtimeStatusTracker.prime(TELEGRAM_RECEIVED_STATUS_TEXT);
      const prepared = await this.prepareTaskAttemptInput(attempt, cleanupDirs);
      if (prepared.imagePaths.length > 0) {
        await runtimeStatusTracker.showImageUnderstanding();
      }

      const handleProviderEvent = (event: ProviderRuntimeEvent) => {
        const latestAttempt = getTelegramAttemptById(attemptId);
        const latestTask = getTelegramTaskById(taskId);
        if (!latestAttempt || !latestTask) {
          return;
        }
        latestAttempt.lastEventAt = Date.now();
        if (event.itemType && ["command_execution", "web_search", "mcp_tool_call", "file_change"].includes(event.itemType)) {
          latestAttempt.hasLongStep = true;
          latestTask.currentPhase = "stable_running";
        } else if (latestTask.currentPhase === "starting" && (event.type === "thread.started" || event.type === "turn.started")) {
          latestTask.currentPhase = "early_running";
        }
        latestAttempt.updatedAt = Date.now();
        latestTask.updatedAt = Date.now();
        updateTelegramAttempt(latestAttempt);
        updateTelegramTask(latestTask);
        runtimeStatusTracker.handleProviderEvent(event);
      };

      const result = await this.callbacks!.runTelegramTaskAttempt({
        attemptId,
        taskId,
        chatId: task.chatId,
        userText: prepared.userText,
        imagePaths: prepared.imagePaths,
        sessionId: task.providerSessionId,
        onEvent: handleProviderEvent,
        signal,
        canPersist: () => {
          const latestTask = getTelegramTaskById(taskId);
          return Boolean(latestTask && latestTask.activeAttemptId === attemptId && latestTask.currentRevision === attempt.revision);
        },
      });

      const latestTask = getTelegramTaskById(taskId);
      const latestAttempt = getTelegramAttemptById(attemptId);
      if (!latestTask || !latestAttempt) {
        return;
      }
      if (signal.aborted && latestTask.currentRevision > latestAttempt.revision) {
        updateTelegramAttempt({
          ...latestAttempt,
          status: "superseded",
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        });
        updateTelegramTask({
          ...latestTask,
          activeAttemptId: null,
          cancelRequestedAt: null,
          status: "queued",
          updatedAt: Date.now(),
        });
        return;
      }

      stopTypingIndicator();
      await runtimeStatusTracker.showSending();
      const commitResult = await this.deps.commitReply(
        this.config!.botToken,
        task.chatId,
        result.text,
        this.workdir,
        {
          existingMessage: status.currentMessage,
          finalReplyMode: this.config!.finalReplyMode,
        },
      );
      persistTelegramAssistantReply(task.chatId, result.text, commitResult.messages);

      updateTelegramAttempt({
        ...latestAttempt,
        status: "completed",
        providerSessionIdAfter: result.sessionId,
        resultText: result.text,
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      });
      updateTelegramTask({
        ...latestTask,
        providerSessionId: result.sessionId,
        latestStatusMessageId: commitResult.reusedExistingMessage
          ? commitResult.messages[0]?.message_id || latestTask.latestStatusMessageId
          : null,
        latestResultMessageId: commitResult.messages[0]?.message_id || latestTask.latestResultMessageId,
        activeAttemptId: null,
        cancelRequestedAt: null,
        status: latestTask.currentRevision > latestAttempt.revision ? "queued" : "completed",
        updatedAt: Date.now(),
      });

      if (!commitResult.reusedExistingMessage) {
        await status.delete();
      }
    } catch (error) {
      const latestTask = getTelegramTaskById(taskId);
      const latestAttempt = getTelegramAttemptById(attemptId);
      if (latestTask && latestAttempt) {
        const nextAttemptStatus = signal.aborted && latestTask.currentRevision > latestAttempt.revision
          ? "superseded"
          : signal.aborted || latestTask.status === "cancelled"
            ? "cancelled"
            : "failed";
        updateTelegramAttempt({
          ...latestAttempt,
          status: nextAttemptStatus,
          errorText: nextAttemptStatus === "failed"
            ? (error instanceof Error ? error.message : String(error))
            : latestAttempt.errorText,
          timeoutKind: error instanceof ProviderTimeoutError ? error.kind : latestAttempt.timeoutKind,
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        });
        updateTelegramTask({
          ...latestTask,
          activeAttemptId: null,
          cancelRequestedAt: null,
          status: latestTask.currentRevision > latestAttempt.revision ? "queued" : nextAttemptStatus === "failed" ? "failed" : "cancelled",
          updatedAt: Date.now(),
        });
        if (nextAttemptStatus === "failed") {
          await status.show(getTelegramBatchFailureText(error));
        }
      }
    } finally {
      clearTimeout(stableTimer);
      runtimeStatusTracker.dispose();
      stopTypingIndicator();
      for (const cleanupDir of cleanupDirs) {
        await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
      }
      const state = this.getChatState(task.chatId);
      if (state.running?.attemptId === attemptId) {
        state.running = null;
      }
    }
  }

  private async prepareTaskAttemptInput(
    attempt: TelegramAttempt,
    cleanupDirs: Set<string>,
  ): Promise<{ userText: string; imagePaths: string[] }> {
    const snapshot = JSON.parse(attempt.inputSnapshotJson) as TelegramTaskInput[];
    const sections: string[] = [];
    const imagePaths: string[] = [];

    for (const [index, input] of snapshot.entries()) {
      if (input.kind === "text") {
        sections.push(this.formatBatchSection(snapshot.length, index, input.text || ""));
        continue;
      }

      const attachment = input.attachmentJson
        ? JSON.parse(input.attachmentJson) as { fileId: string; fileName: string }
        : null;
      if (!attachment?.fileId) {
        sections.push(this.formatBatchSection(snapshot.length, index, input.text || ""));
        continue;
      }

      const downloaded = await downloadTelegramFile(
        this.config!.botToken,
        attachment.fileId,
        attachment.fileName,
      );
      cleanupDirs.add(path.dirname(downloaded.filePath));

      if (input.kind === "photo") {
        imagePaths.push(downloaded.filePath);
        sections.push(this.formatBatchSection(snapshot.length, index, input.text || "用户发来了一张图片。"));
        continue;
      }

      const documentText = [
        input.text || "用户发来了一份文件。",
        "",
        `文件名: ${downloaded.fileName}`,
        `本地路径: ${downloaded.filePath}`,
        "",
        "请优先读取并理解这个文件，再直接回答用户问题。",
      ].join("\n");
      sections.push(this.formatBatchSection(snapshot.length, index, documentText));
    }

    if (sections.length === 1) {
      return {
        userText: sections[0] || "",
        imagePaths,
      };
    }

    return {
      userText: [
        "The following new messages arrived sequentially in the same Telegram chat.",
        "Treat later items as immediate additions or follow-ups to the same conversation unless they explicitly redirect the task.",
        "",
        sections.join("\n\n"),
      ].join("\n"),
      imagePaths,
    };
  }

  private formatBatchSection(total: number, index: number, text: string): string {
    if (total <= 1) {
      return text;
    }
    return `Message ${index + 1}:\n${text}`;
  }

  private async ensureTaskStatusMessage(task: TelegramTask, replyToMessageId: number, text: string): Promise<void> {
    const controller = this.createStatusController(task.chatId, replyToMessageId);
    if (task.latestStatusMessageId) {
      controller.seedExisting(createPlaceholderTelegramMessage(task.chatId, task.latestStatusMessageId));
    }
    await controller.show(text, { clearKeyboard: true });
    updateTelegramTask({
      ...task,
      latestStatusMessageId: controller.messageId,
      updatedAt: Date.now(),
    });
  }

  private async resetChatState(chatId: string, state: ChatState): Promise<void> {
    cancelTelegramTasksByChat(chatId, Date.now());
    await cleanupTelegramChatState(state);
  }

  private createStatusController(chatId: string, replyToMessageId: number): StatusMessageController {
    return new StatusMessageController(
      this.config!.botToken,
      Number(chatId),
      replyToMessageId,
      {
        send: this.deps.sendMessage,
        edit: this.deps.editMessageText,
        delete: this.deps.deleteMessage,
      },
    );
  }
}

function persistTelegramInboundMessage(message: TelegramMessage): void {
  const content = describeTelegramMedia(message);
  if (!content.trim()) {
    return;
  }

  saveTelegramMessageRef({
    chatId: String(message.chat.id),
    messageId: message.message_id,
    role: "user",
    content: truncateTelegramContext(content),
    createdAt: message.date * 1000,
  });
}

function persistTelegramAssistantReply(
  chatId: string,
  reply: string,
  sentMessages: TelegramMessage[],
): void {
  const content = truncateTelegramContext(reply);
  if (!content.trim()) {
    return;
  }

  const createdAt = Date.now();
  for (const sentMessage of sentMessages) {
    saveTelegramMessageRef({
      chatId,
      messageId: sentMessage.message_id,
      role: "assistant",
      content,
      createdAt,
    });
  }
}

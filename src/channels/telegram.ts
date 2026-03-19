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
  getTelegramUpdates,
  sendTelegramChatAction,
  sendTelegramMessage,
  sendTelegramReply,
  type TelegramCallbackQuery,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate,
} from "../telegram.js";
import type { ProviderRuntimeEvent } from "../providers/index.js";
import {
  findTelegramMessageRef,
  saveTelegramMessageRef,
} from "../web/db.js";

const MAX_HANDLED_UPDATE_IDS = 5000;
const CHAT_ACTION_REFRESH_MS = 4000;
const DECISION_TIMEOUT_MS = 5000;
const SUPPLEMENT_CONFIRM_MS = 1000;
const SUPPLEMENT_STATUS_TEXT = "已按“补充当前任务”处理";
const SUPPLEMENT_TIMEOUT_TEXT = "未选择，已默认按“补充当前任务”处理";
const SUPPLEMENT_RUNNING_TEXT = "正在重新整理你的问题…";
const QUEUED_STATUS_TEXT = "排队中…";
const RUNNING_STATUS_TEXT = "正在理解你的问题…";
const FINALIZING_STATUS_TEXT = "正在整理回答…";
const SENDING_STATUS_TEXT = "正在发送回复…";
const STALE_DECISION_TEXT = "该选项已失效";
const CALLBACK_PREFIX = "tgd";

type PendingKind = "text" | "photo" | "document";
type DecisionAction = "supplement" | "queue";

interface PendingItem {
  kind: PendingKind;
  message: TelegramMessage;
}

interface PendingBatch {
  id: string;
  items: PendingItem[];
  status: StatusMessageController;
}

interface RunningTask {
  id: string;
  batch: PendingBatch;
  abortController: AbortController;
  generation: number;
}

interface PendingDecision {
  id: string;
  batch: PendingBatch;
  timer: NodeJS.Timeout | null;
}

interface PendingRestart {
  batch: PendingBatch;
  earliestStartAt: number;
  combinedItemCount: number;
}

interface ChatState {
  running: RunningTask | null;
  decision: PendingDecision | null;
  queued: PendingBatch[];
  pendingRestart: PendingRestart | null;
  generation: number;
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

class StatusMessageController {
  private statusMessage: TelegramMessage | null = null;

  constructor(
    private readonly botToken: string,
    private readonly chatId: number,
    private readonly replyToMessageId: number,
  ) {}

  get messageId(): number | null {
    return this.statusMessage?.message_id || null;
  }

  get currentMessage(): TelegramMessage | null {
    return this.statusMessage;
  }

  async show(
    text: string,
    opts?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
      clearKeyboard?: boolean;
    },
  ): Promise<void> {
    const replyMarkup = opts?.clearKeyboard ? { inline_keyboard: [] } : opts?.replyMarkup;

    if (!this.statusMessage) {
      this.statusMessage = await sendTelegramMessage(this.botToken, this.chatId, text, {
        replyToMessageId: this.replyToMessageId,
        replyMarkup,
      });
      return;
    }

    await editTelegramMessageText(
      this.botToken,
      this.chatId,
      this.statusMessage.message_id,
      text,
      replyMarkup ? { replyMarkup } : undefined,
    );
  }

  async delete(): Promise<void> {
    if (!this.statusMessage) {
      return;
    }

    try {
      await deleteTelegramMessage(this.botToken, this.chatId, this.statusMessage.message_id);
    } catch (error) {
      logger.warn("telegram.status.delete_failed", {
        chatId: this.chatId,
        messageId: this.statusMessage.message_id,
        error,
      });
    } finally {
      this.statusMessage = null;
    }
  }
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

function shouldSwitchToFinalizingStatus(event: ProviderRuntimeEvent): boolean {
  return event.type === "item.completed" && event.itemType === "agent_message";
}

function buildDecisionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildDecisionKeyboard(decisionId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "补充", callback_data: `${CALLBACK_PREFIX}:supplement:${decisionId}` },
      { text: "排队", callback_data: `${CALLBACK_PREFIX}:queue:${decisionId}` },
    ]],
  };
}

function buildDecisionPromptText(itemCount: number): string {
  if (itemCount <= 1) {
    return "收到新消息，如何处理？";
  }
  return `收到 ${itemCount} 条新消息，如何处理？`;
}

function buildSupplementRunningText(itemCount: number): string {
  if (itemCount > 1) {
    return `正在重新整理你刚才的 ${itemCount} 条消息…`;
  }
  return SUPPLEMENT_RUNNING_TEXT;
}

function parseDecisionCallback(data?: string): { action: DecisionAction; decisionId: string } | null {
  if (!data) {
    return null;
  }

  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }

  const action = parts[1];
  if (action !== "supplement" && action !== "queue") {
    return null;
  }

  return {
    action,
    decisionId: parts[2],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startTypingIndicatorLoop(
  botToken: string,
  chatId: string,
  isActive: () => boolean,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    if (stopped || !isActive()) {
      return;
    }

    void sendTelegramChatAction(botToken, chatId, "typing").catch((error) => {
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

function isResetCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "/new" || trimmed === "/reset" || trimmed === "/start";
}

export class TelegramChannel implements IChannel {
  readonly type = "telegram";

  private config: TelegramChannelConfig | null = null;
  private callbacks: ChannelCallbacks | null = null;
  private handledUpdateIds = new CappedSet<number>(MAX_HANDLED_UPDATE_IDS);
  private running = false;
  private pollLoopPromise: Promise<void> | null = null;
  private pollAbortController: AbortController | null = null;
  private offset: number | null = null;
  private readonly workdir = process.env.CODEX_WORKDIR || process.cwd();
  private readonly chatStates = new Map<string, ChatState>();

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

    await this.primeOffset();
    this.pollLoopPromise = this.pollLoop();
    logger.info("telegram.started", {
      privateOnly: config.privateOnly,
      allowGroups: config.allowGroups,
      pollingTimeoutSeconds: config.pollingTimeoutSeconds,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;

    for (const state of this.chatStates.values()) {
      state.decision?.timer && clearTimeout(state.decision.timer);
      state.running?.abortController.abort();
    }

    try {
      await this.pollLoopPromise;
    } catch {
      // Ignore polling shutdown errors.
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
        queued: [],
        pendingRestart: null,
        generation: 0,
      };
      this.chatStates.set(chatId, state);
    }
    return state;
  }

  private async primeOffset(): Promise<void> {
    if (!this.config?.botToken) {
      return;
    }

    try {
      const updates = await getTelegramUpdates(this.config.botToken, null, 0);
      if (updates.length > 0) {
        this.offset = updates[updates.length - 1]!.update_id + 1;
      }
    } catch (error) {
      logger.warn("telegram.offset.prime_failed", { error });
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running && this.config?.botToken) {
      this.pollAbortController = new AbortController();

      try {
        const updates = await getTelegramUpdates(
          this.config.botToken,
          this.offset,
          this.config.pollingTimeoutSeconds,
          this.pollAbortController.signal,
        );

        for (const update of updates) {
          void this.handleUpdate(update).catch((error) => {
            logger.error("telegram.update.handle_failed", {
              updateId: update.update_id,
              error,
            });
          });
          this.offset = update.update_id + 1;
        }
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

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.handledUpdateIds.has(update.update_id)) {
      return;
    }
    this.handledUpdateIds.add(update.update_id);

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (!update.message) {
      return;
    }

    const message = update.message;
    const config = this.config!;

    logger.info("telegram.message.received", {
      updateId: update.update_id,
      messageId: message.message_id,
      chatId: message.chat.id,
      chatType: message.chat.type,
      hasText: Boolean(message.text),
      hasPhoto: Boolean(message.photo?.length),
      hasDocument: Boolean(message.document),
    });

    if (config.privateOnly && !isPrivateMessage(message)) {
      return;
    }
    if (!config.allowGroups && message.chat.type !== "private") {
      return;
    }

    if (isPrivateMessage(message) && !config.ownerChatId) {
      config.ownerChatId = String(message.chat.id);
      updateChannelConfig("telegram", { ownerChatId: config.ownerChatId });
      logger.info("telegram.owner_auto_saved", {
        chatId: message.chat.id,
      });
    }

    persistTelegramInboundMessage(message);

    if (message.document && !isSupportedFeishuDocumentFileName(message.document.file_name || "unknown")) {
      await sendTelegramMessage(config.botToken, message.chat.id, buildUnsupportedFeishuFileMessage(
        message.document.file_name || "unknown",
      ));
      return;
    }

    await this.handleIncomingMessage(message);
  }

  private async handleIncomingMessage(message: TelegramMessage): Promise<void> {
    const botToken = this.config!.botToken;
    const chatId = String(message.chat.id);
    const userText = getMessageText(message);
    const state = this.getChatState(chatId);

    if (!message.photo?.length && !message.document && !userText) {
      await sendTelegramMessage(botToken, message.chat.id, "请直接发送文字问题。");
      return;
    }

    if (userText) {
      const cmd = await handleCommand(userText, chatId, "telegram", this.callbacks!);
      if (cmd.handled) {
        if (isResetCommand(userText)) {
          await this.resetChatState(state);
        }
        if (cmd.reply) {
          await sendTelegramMessage(botToken, message.chat.id, cmd.reply);
        }
        return;
      }
    }

    const item: PendingItem = {
      kind: message.photo?.length ? "photo" : message.document ? "document" : "text",
      message,
    };

    if (!state.running) {
      const batch = this.createBatch(botToken, message, [item]);
      await this.startBatch(chatId, state, batch, RUNNING_STATUS_TEXT);
      return;
    }

    if (state.decision) {
      const existingItems = [...state.decision.batch.items, item];
      if (state.decision.timer) {
        clearTimeout(state.decision.timer);
        state.decision.timer = null;
      }

      await state.decision.batch.status.delete();

      const refreshedBatch = this.createBatch(botToken, message, existingItems);
      const refreshedDecision: PendingDecision = {
        id: buildDecisionId(),
        batch: refreshedBatch,
        timer: null,
      };
      state.decision = refreshedDecision;

      await refreshedBatch.status.show(
        buildDecisionPromptText(existingItems.length),
        {
          replyMarkup: buildDecisionKeyboard(refreshedDecision.id),
        },
      );
      this.resetDecisionTimer(chatId, state, refreshedDecision);
      return;
    }

    const decisionBatch = this.createBatch(botToken, message, [item]);
    const decisionId = buildDecisionId();
    const decision: PendingDecision = {
      id: decisionId,
      batch: decisionBatch,
      timer: null,
    };
    state.decision = decision;

    await decision.batch.status.show(buildDecisionPromptText(decision.batch.items.length), {
      replyMarkup: buildDecisionKeyboard(decisionId),
    });
    this.resetDecisionTimer(chatId, state, decision);
  }

  private createBatch(
    botToken: string,
    anchorMessage: TelegramMessage,
    items: PendingItem[],
  ): PendingBatch {
    return {
      id: buildDecisionId(),
      items,
      status: new StatusMessageController(botToken, anchorMessage.chat.id, anchorMessage.message_id),
    };
  }

  private resetDecisionTimer(chatId: string, state: ChatState, decision: PendingDecision): void {
    if (decision.timer) {
      clearTimeout(decision.timer);
    }

    decision.timer = setTimeout(() => {
      void this.resolveDecision(chatId, state, decision.id, "supplement", true);
    }, DECISION_TIMEOUT_MS);
  }

  private async handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const parsed = parseDecisionCallback(callbackQuery.data);
    if (!parsed || !callbackQuery.message || !callbackQuery.message.chat) {
      await answerTelegramCallbackQuery(this.config!.botToken, callbackQuery.id, {
        text: STALE_DECISION_TEXT,
      }).catch(() => {});
      return;
    }

    const chatId = String(callbackQuery.message.chat.id);
    const state = this.getChatState(chatId);
    const decision = state.decision;

    if (!decision || decision.id !== parsed.decisionId) {
      await answerTelegramCallbackQuery(this.config!.botToken, callbackQuery.id, {
        text: STALE_DECISION_TEXT,
      }).catch(() => {});
      return;
    }

    await answerTelegramCallbackQuery(this.config!.botToken, callbackQuery.id).catch(() => {});
    await this.resolveDecision(chatId, state, parsed.decisionId, parsed.action, false);
  }

  private async resolveDecision(
    chatId: string,
    state: ChatState,
    decisionId: string,
    action: DecisionAction,
    fromTimeout: boolean,
  ): Promise<void> {
    const decision = state.decision;
    if (!decision || decision.id !== decisionId) {
      return;
    }

    if (decision.timer) {
      clearTimeout(decision.timer);
      decision.timer = null;
    }
    state.decision = null;

    if (action === "queue") {
      await decision.batch.status.show(QUEUED_STATUS_TEXT, { clearKeyboard: true });
      state.queued.push(decision.batch);
      return;
    }

    await decision.batch.status.show(
      fromTimeout ? SUPPLEMENT_TIMEOUT_TEXT : SUPPLEMENT_STATUS_TEXT,
      { clearKeyboard: true },
    );

    const running = state.running;
    if (!running) {
      state.pendingRestart = {
        batch: decision.batch,
        earliestStartAt: Date.now() + SUPPLEMENT_CONFIRM_MS,
        combinedItemCount: decision.batch.items.length,
      };
      await this.maybeStartNextBatch(chatId, state);
      return;
    }

    const mergedBatch: PendingBatch = {
      id: buildDecisionId(),
      items: [...running.batch.items, ...decision.batch.items],
      status: decision.batch.status,
    };

    state.pendingRestart = {
      batch: mergedBatch,
      earliestStartAt: Date.now() + SUPPLEMENT_CONFIRM_MS,
      combinedItemCount: mergedBatch.items.length,
    };

    await running.batch.status.delete();
    running.abortController.abort();
  }

  private async startBatch(
    chatId: string,
    state: ChatState,
    batch: PendingBatch,
    startText: string,
  ): Promise<void> {
    if (state.running) {
      return;
    }

    state.generation += 1;
    const running: RunningTask = {
      id: buildDecisionId(),
      batch,
      abortController: new AbortController(),
      generation: state.generation,
    };
    state.running = running;

    await batch.status.show(startText, { clearKeyboard: true });

    void this.executeBatch(chatId, state, running).catch((error) => {
      logger.error("telegram.batch.unhandled_failure", {
        chatId,
        batchId: batch.id,
        error,
      });
    });
  }

  private async executeBatch(
    chatId: string,
    state: ChatState,
    running: RunningTask,
  ): Promise<void> {
    const currentRunning = state.running;
    if (!currentRunning || currentRunning.id !== running.id) {
      return;
    }

    const botToken = this.config!.botToken;
    const cleanupDirs = new Set<string>();
    const stopTypingIndicator = startTypingIndicatorLoop(
      botToken,
      chatId,
      () => state.running?.id === running.id && !running.abortController.signal.aborted,
    );

    try {
      const prepared = await this.prepareBatchInput(botToken, running.batch, cleanupDirs);
      let finalizingStatusSent = false;
      const handleProviderEvent = (event: ProviderRuntimeEvent) => {
        if (
          state.running?.id !== running.id
          || finalizingStatusSent
          || !shouldSwitchToFinalizingStatus(event)
        ) {
          return;
        }

        finalizingStatusSent = true;
        void running.batch.status.show(FINALIZING_STATUS_TEXT);
      };

      const reply = await this.callbacks!.generateReply(
        chatId,
        prepared.userText,
        prepared.imagePaths,
        "telegram",
        handleProviderEvent,
        running.abortController.signal,
      );

      if (running.abortController.signal.aborted || state.running?.id !== running.id) {
        return;
      }

      stopTypingIndicator();
      await running.batch.status.show(SENDING_STATUS_TEXT);
      const commitResult = await commitTelegramReply(
        botToken,
        chatId,
        reply,
        this.workdir,
        {
          existingMessage: running.batch.status.currentMessage,
          finalReplyMode: this.config!.finalReplyMode,
        },
      );

      if (state.running?.id !== running.id) {
        return;
      }

      persistTelegramAssistantReply(chatId, reply, commitResult.messages);
      if (!commitResult.reusedExistingMessage) {
        await running.batch.status.delete();
      }
    } catch (error) {
      if (running.abortController.signal.aborted) {
        logger.info("telegram.batch.aborted", {
          chatId,
          batchId: running.batch.id,
        });
      } else {
        logger.error("telegram.batch.failed", {
          chatId,
          batchId: running.batch.id,
          error,
        });
        if (state.running?.id === running.id) {
          await running.batch.status.show("处理消息时出错了，请稍后再试。");
        }
      }
    } finally {
      stopTypingIndicator();

      for (const cleanupDir of cleanupDirs) {
        await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
      }

      if (state.running?.id === running.id) {
        state.running = null;
      }

      await this.maybeStartNextBatch(chatId, state);
    }
  }

  private async maybeStartNextBatch(chatId: string, state: ChatState): Promise<void> {
    if (state.running) {
      return;
    }

    if (state.pendingRestart) {
      const restart = state.pendingRestart;
      state.pendingRestart = null;

      const waitMs = restart.earliestStartAt - Date.now();
      if (waitMs > 0) {
        await delay(waitMs);
      }

      if (state.running) {
        return;
      }

      await this.startBatch(
        chatId,
        state,
        restart.batch,
        buildSupplementRunningText(restart.combinedItemCount),
      );
      return;
    }

    if (state.decision) {
      const decision = state.decision;
      if (decision.timer) {
        clearTimeout(decision.timer);
        decision.timer = null;
      }
      state.decision = null;
      await this.startBatch(chatId, state, decision.batch, RUNNING_STATUS_TEXT);
      return;
    }

    const nextQueued = state.queued.shift();
    if (nextQueued) {
      await this.startBatch(chatId, state, nextQueued, RUNNING_STATUS_TEXT);
    }
  }

  private async prepareBatchInput(
    botToken: string,
    batch: PendingBatch,
    cleanupDirs: Set<string>,
  ): Promise<{ userText: string; imagePaths: string[] }> {
    const sections: string[] = [];
    const imagePaths: string[] = [];

    for (const [index, item] of batch.items.entries()) {
      if (item.kind === "text") {
        sections.push(this.formatBatchSection(
          batch.items.length,
          index,
          buildTelegramUserPrompt(item.message, getMessageText(item.message)),
        ));
        continue;
      }

      if (item.kind === "photo") {
        const photo = item.message.photo?.[item.message.photo.length - 1];
        if (!photo) {
          sections.push(this.formatBatchSection(
            batch.items.length,
            index,
            buildTelegramUserPrompt(item.message, "用户发来了一张图片。请根据图片内容直接回答。"),
          ));
          continue;
        }

        const downloaded = await downloadTelegramFile(botToken, photo.file_id, "telegram-photo.jpg");
        imagePaths.push(downloaded.filePath);
        cleanupDirs.add(path.dirname(downloaded.filePath));
        sections.push(this.formatBatchSection(
          batch.items.length,
          index,
          buildTelegramUserPrompt(
            item.message,
            getMessageText(item.message) || "用户发来了一张图片。请根据图片内容直接回答。",
          ),
        ));
        continue;
      }

      const document = item.message.document;
      if (!document?.file_id) {
        sections.push(this.formatBatchSection(
          batch.items.length,
          index,
          buildTelegramUserPrompt(item.message, "用户发来了一个文件，但附件内容暂时无法读取。"),
        ));
        continue;
      }

      const downloaded = await downloadTelegramFile(
        botToken,
        document.file_id,
        document.file_name || "telegram-document",
      );
      cleanupDirs.add(path.dirname(downloaded.filePath));
      const text = [
        "用户发来了一个文件。",
        `文件名: ${downloaded.fileName}`,
        `本地路径: ${downloaded.filePath}`,
        "",
        "请优先读取并理解这个文件，再直接回答用户可能想了解的内容。",
        "如果文件内容不足以完成任务，先简要说明你从文件里看到了什么，再说明还需要什么上下文。",
        "如果该文件格式不适合直接解析，也请明确说明限制。",
      ].join("\n");
      sections.push(this.formatBatchSection(
        batch.items.length,
        index,
        buildTelegramUserPrompt(item.message, text),
      ));
    }

    if (sections.length === 1) {
      return {
        userText: sections[0]!,
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

  private async resetChatState(state: ChatState): Promise<void> {
    state.decision?.timer && clearTimeout(state.decision.timer);
    state.decision = null;
    state.pendingRestart = null;

    if (state.running) {
      state.running.abortController.abort();
      await state.running.batch.status.delete();
      state.running = null;
    }

    for (const queued of state.queued) {
      await queued.status.delete();
    }
    state.queued = [];
  }
}

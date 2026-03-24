import { readFile, stat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Blob } from "node:buffer";
import { fetch as undiciFetch, FormData } from "undici";

import { parseReplyPayload, sanitizeIncomingFileName } from "./message.js";
import { logger } from "./logger.js";
import type { TelegramFinalReplyMode } from "./channels/types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_DOWNLOAD_BASE = "https://api.telegram.org/file";
const MAX_TELEGRAM_UPLOAD_BYTES = 49 * 1024 * 1024;
const MAX_TELEGRAM_DRAFT_TEXT_LENGTH = 4096;
export const TELEGRAM_REPLY_REUSED_NOTIFICATION_TEXT = "上方回复已更新";
const TELEGRAM_REPLY_REUSED_NOTIFICATION_TTL_MS = 15_000;
const TELEGRAM_REFERENCE_HEADER_PATTERN = /^\s*(?:参考代码|参考文件|对应代码位置|相关代码|代码位置)\s*[:：]?\s*$/u;
const TELEGRAM_STANDALONE_REFERENCE_PATTERN = /^\s*(?:[-*•]\s*)?(?:[`"']?[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+[`"']?\s*)+$/u;

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramTextQuote {
  text?: string;
  position?: number;
  is_manual?: boolean;
}

export interface TelegramExternalReply {
  message_id?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  quote?: TelegramTextQuote;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  chat_instance: string;
  message?: TelegramMessage;
  inline_message_id?: string;
  data?: string;
  game_short_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  reply_to_message?: TelegramMessage;
  quote?: TelegramTextQuote;
  external_reply?: TelegramExternalReply;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  callback_game?: Record<string, never>;
  pay?: boolean;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "upload_document";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
}

type TelegramReplyMarkup = TelegramInlineKeyboardMarkup;
type TelegramEditedMessage = TelegramMessage | true;

export interface TelegramReplyCommitResult {
  messages: TelegramMessage[];
  reusedExistingMessage: boolean;
}

function isLocalPathTarget(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\.{1,2}[\\/])/.test(value.trim());
}

function stripPathLocationSuffix(value: string): string {
  return value.replace(/(#L\d+(?:C\d+)?)|:\d+(?::\d+)?$/u, "");
}

function basenameFromLocalTarget(value: string): string {
  const cleaned = stripPathLocationSuffix(value).replace(/[\\/]+$/u, "");
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function replaceLocalMarkdownLinks(line: string): { text: string; replaced: boolean } {
  let replaced = false;
  const text = line.replace(/\[([^\]]+)\]\(([^)\n]+)\)/gu, (full, label: string, target: string) => {
    if (!isLocalPathTarget(target)) {
      return full;
    }
    replaced = true;
    const cleanLabel = label.trim();
    return cleanLabel || basenameFromLocalTarget(target);
  });
  return { text, replaced };
}

function replaceBareLocalPaths(line: string): { text: string; replaced: boolean } {
  let replaced = false;
  const text = line.replace(
    /(?:[a-zA-Z]:[\\/]|(?<!https?:)\/)(?:[^\s<>"')\]]+[\\/])*[^\s<>"')\]]+/gu,
    (candidate: string) => {
      if (!isLocalPathTarget(candidate)) {
        return candidate;
      }
      replaced = true;
      return basenameFromLocalTarget(candidate);
    },
  );
  return { text, replaced };
}

function sanitizeTelegramReferenceLine(line: string): { text: string; removed: boolean; hadReference: boolean } {
  const markdownReplaced = replaceLocalMarkdownLinks(line);
  const pathReplaced = replaceBareLocalPaths(markdownReplaced.text);
  const text = pathReplaced.text
    .replace(/#L\d+(?:C\d+)?/gu, "")
    .replace(/:(\d+)(?::\d+)?(?=$|\s|[，。；,;:：])/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  const hadReference = markdownReplaced.replaced || pathReplaced.replaced;

  if (!hadReference) {
    return { text: line, removed: false, hadReference: false };
  }

  if (!text || TELEGRAM_STANDALONE_REFERENCE_PATTERN.test(text)) {
    return { text: "", removed: true, hadReference: true };
  }

  return { text, removed: false, hadReference: true };
}

export function sanitizeTelegramReferenceText(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const sanitizedLines: string[] = [];
  let skippingReferenceBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (TELEGRAM_REFERENCE_HEADER_PATTERN.test(line)) {
      skippingReferenceBlock = true;
      continue;
    }

    const sanitized = sanitizeTelegramReferenceLine(line);
    if (skippingReferenceBlock) {
      if (!line.trim()) {
        skippingReferenceBlock = false;
        continue;
      }
      if (sanitized.hadReference || !sanitized.text) {
        continue;
      }
      skippingReferenceBlock = false;
    }

    if (sanitized.removed) {
      continue;
    }

    sanitizedLines.push(sanitized.text);
  }

  return sanitizedLines
    .join("\n")
    .replace(/^按现在代码/u, "按现在实现")
    .replace(/^从实现上看/u, "从现在实现看")
    .replace(/^\s*(?:参考代码|参考文件|对应实现)[:：]?\s*/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripTelegramBackticks(text: string): string {
  return text.replace(/`([^`]+)`/gu, (_full, inner: string) => {
    const token = inner.trim();
    if (!token) {
      return "";
    }
    if (/^\/[A-Za-z0-9_@-]+$/u.test(token)) {
      return token;
    }
    if (/^stop$/iu.test(token)) {
      return "/stop";
    }
    return token;
  });
}

function normalizeTelegramStyleLine(line: string): string {
  if (!line.trim()) {
    return "";
  }

  const isBullet = /^[-*•]\s*/u.test(line);
  let content = line.replace(/^[-*•]\s*/u, "").trim();

  content = content
    .replace(/\bdecision_pending\b/giu, "待决定")
    .replace(/\bwaiting_next_attempt\b/giu, "等下一轮")
    .replace(/\bqueued\b/giu, "排队中")
    .replace(/\brunning\b/giu, "正在处理")
    .replace(/\bcancelled\b/giu, "已取消")
    .replace(/二选一决策/gu, "确认怎么处理")
    .replace(/待你确认怎么处理的任务/gu, "等你确认怎么处理的任务")
    .replace(/待你确认怎么处理/gu, "等你确认怎么处理")
    .replace(/中止控制器/gu, "")
    .replace(/中止当前执行（\s*）/gu, "直接中止当前执行")
    .replace(/中止当前执行\s*\(\s*\)/gu, "直接中止当前执行")
    .replace(/中止当前执行（[^）]*）/gu, "直接中止当前执行")
    .replace(/\bAbortController\b/gu, "直接中止当前执行")
    .replace(/\bprovider execution\b/giu, "这轮执行")
    .replace(/\bprovider\b/giu, "这轮执行")
    .replace(/\bsession\b/giu, "上下文")
    .replace(/\bSQLite\b/gu, "本地任务记录")
    .replace(/\bchat\b/giu, "聊天")
    .replace(/当前这个\s*聊天/u, "当前聊天")
    .replace(/作用范围只限当前聊天/u, "只影响当前聊天")
    .replace(/\s{2,}/gu, " ")
    .trim();

  if (/^现在\s*\/?stop\s*的实现很直接[:：]/iu.test(content)) {
    return "简单说：/stop 会停止当前聊天里的任务，但不会清空上下文。";
  }

  if (/^(按现在实现|从现在实现看)[，,:：]/u.test(content)) {
    return content.replace(/^(按现在实现|从现在实现看)[，,:：]\s*/u, "简单说：");
  }

  if (/带机器人名/u.test(content) || (/别的 bot/u.test(content) && /\/stop/u.test(content))) {
    return "- 如果带机器人名，也只会处理发给自己的 /stop。";
  }

  if (
    /所有活跃任务/u.test(content)
    || /覆盖.*(待决定|排队中|正在处理|等下一轮)/u.test(content)
    || (/排队中/u.test(content) && /正在处理/u.test(content))
  ) {
    return "- 正在跑的会被中止，排队和待确认的也会一起取消。";
  }

  if (
    /不会重置上下文/u.test(content)
    || /不会清空上下文/u.test(content)
    || (/直接中止当前执行/u.test(content) && /上下文/u.test(content))
  ) {
    return "- 它不会清空上下文，之后还能继续原来的会话。";
  }

  if (/Telegram 专用命令.*只影响当前聊天/u.test(content)) {
    return isBullet ? "- 只会影响当前这个聊天里的任务。" : "简单说：/stop 会停止当前聊天里的任务，但不会清空上下文。";
  }

  return isBullet ? `- ${content}` : content;
}

export function normalizeTelegramReplyStyle(text: string): string {
  const normalized = stripTelegramBackticks(text)
    .replace(/^现在\s+(.+?)\s+的实现很直接[:：]\s*/u, "简单说：")
    .replace(/^按现在实现[，,:：]\s*/u, "简单说：")
    .replace(/^从现在实现看[，,:：]\s*/u, "简单说：")
    .replace(/它是 Telegram 专用命令，作用范围只限当前(?:这个)?\s*聊天。?/u, "简单说：/stop 会停止当前聊天里的任务，但不会清空上下文。")
    .replace(/简单说，/u, "简单说：")
    .replace(/不会重置上下文/u, "不会清空上下文")
    .replace(/不会重置 session/giu, "不会清空上下文");

  const lines = normalized
    .split("\n")
    .map((line) => normalizeTelegramStyleLine(line))
    .filter((line, index, allLines) => {
      if (line) {
        return true;
      }
      return index > 0 && index < allLines.length - 1 && Boolean(allLines[index - 1] || allLines[index + 1]);
    });

  return lines
    .join("\n")
    .replace(/简单说：\s*\/stop\s+会/u, "简单说：/stop 会")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function sanitizeTelegramReplyText(text: string): string {
  return normalizeTelegramReplyStyle(sanitizeTelegramReferenceText(text));
}

function buildMethodUrl(botToken: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

function buildFileUrl(botToken: string, filePath: string): string {
  return `${TELEGRAM_DOWNLOAD_BASE}/bot${botToken}/${filePath}`;
}

function getTelegramErrorMessage(
  payload: TelegramResponse<unknown>,
  fallback: string,
): string {
  return payload.description?.trim() || fallback;
}

async function telegramJsonRequest<T>(
  botToken: string,
  method: string,
  data: Record<string, unknown>,
  fallbackMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await undiciFetch(buildMethodUrl(botToken, method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    signal,
  });

  const payload = await response.json() as TelegramResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(getTelegramErrorMessage(payload, fallbackMessage));
  }

  return payload.result;
}

async function telegramMultipartRequest<T>(
  botToken: string,
  method: string,
  formData: FormData,
  fallbackMessage: string,
): Promise<T> {
  const response = await undiciFetch(buildMethodUrl(botToken, method), {
    method: "POST",
    body: formData,
  });

  const payload = await response.json() as TelegramResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(getTelegramErrorMessage(payload, fallbackMessage));
  }

  return payload.result;
}

export async function getTelegramUpdates(
  botToken: string,
  offset: number | null,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  return telegramJsonRequest<TelegramUpdate[]>(
    botToken,
    "getUpdates",
    {
      ...(typeof offset === "number" ? { offset } : {}),
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    },
    "Failed to fetch Telegram updates",
    signal,
  );
}

export async function getTelegramMe(
  botToken: string,
  signal?: AbortSignal,
): Promise<TelegramUser> {
  return telegramJsonRequest<TelegramUser>(
    botToken,
    "getMe",
    {},
    "Failed to fetch Telegram bot profile",
    signal,
  );
}

interface TelegramSendMessageOptions {
  clearDraft?: boolean;
  replyToMessageId?: number;
  inlineKeyboard?: TelegramReplyMarkup;
  replyMarkup?: TelegramReplyMarkup;
  parseMode?: string;
  disableWebPagePreview?: boolean;
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  opts?: TelegramSendMessageOptions,
): Promise<TelegramMessage> {
  return telegramJsonRequest<TelegramMessage>(
    botToken,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      ...(opts?.inlineKeyboard || opts?.replyMarkup
        ? { reply_markup: opts.inlineKeyboard || opts.replyMarkup }
        : {}),
      ...(typeof opts?.replyToMessageId === "number"
        ? { reply_to_message_id: opts.replyToMessageId }
        : {}),
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(typeof opts?.disableWebPagePreview === "boolean"
        ? { disable_web_page_preview: opts.disableWebPagePreview }
        : {}),
      ...(opts?.clearDraft ? { clear_draft: true } : {}),
    },
    "Failed to send Telegram message",
  );
}

interface TelegramSendMediaOptions {
  clearDraft?: boolean;
  replyMarkup?: TelegramReplyMarkup;
}

export async function sendTelegramChatAction(
  botToken: string,
  chatId: string | number,
  action: TelegramChatAction,
  signal?: AbortSignal,
): Promise<true> {
  return telegramJsonRequest<true>(
    botToken,
    "sendChatAction",
    {
      chat_id: chatId,
      action,
    },
    "Failed to send Telegram chat action",
    signal,
  );
}

export async function sendTelegramAnswerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  opts?: {
    text?: string;
    showAlert?: boolean;
    url?: string;
    cacheTime?: number;
  },
): Promise<true> {
  return telegramJsonRequest<true>(
    botToken,
    "answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      ...(opts?.text ? { text: opts.text } : {}),
      ...(typeof opts?.showAlert === "boolean" ? { show_alert: opts.showAlert } : {}),
      ...(opts?.url ? { url: opts.url } : {}),
      ...(typeof opts?.cacheTime === "number" ? { cache_time: opts.cacheTime } : {}),
    },
    "Failed to answer Telegram callback query",
  );
}

export { sendTelegramAnswerCallbackQuery as answerTelegramCallbackQuery };

export async function sendTelegramEditMessageText(
  botToken: string,
  chatId: string | number | undefined,
  messageId: number | undefined,
  text: string,
  opts?: {
    inlineMessageId?: string;
    inlineKeyboard?: TelegramReplyMarkup;
    replyMarkup?: TelegramReplyMarkup;
    parseMode?: string;
    disableWebPagePreview?: boolean;
  },
): Promise<TelegramEditedMessage> {
  return telegramJsonRequest<TelegramEditedMessage>(
    botToken,
    "editMessageText",
    {
      ...(opts?.inlineMessageId
        ? { inline_message_id: opts.inlineMessageId }
        : (() => {
            if (chatId === undefined || messageId === undefined) {
              throw new Error("chatId and messageId are required when inlineMessageId is not set");
            }
            return { chat_id: chatId, message_id: messageId };
          })()),
      text,
      ...(opts?.inlineKeyboard || opts?.replyMarkup
        ? { reply_markup: opts.inlineKeyboard || opts.replyMarkup }
        : {}),
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(typeof opts?.disableWebPagePreview === "boolean"
        ? { disable_web_page_preview: opts.disableWebPagePreview }
        : {}),
    },
    "Failed to edit Telegram message text",
  );
}

export { sendTelegramEditMessageText as editTelegramMessageText };

export async function sendTelegramEditMessageReplyMarkup(
  botToken: string,
  chatId: string | number | undefined,
  messageId: number | undefined,
  replyMarkup?: TelegramReplyMarkup,
  opts?: {
    inlineMessageId?: string;
  },
): Promise<TelegramEditedMessage> {
  return telegramJsonRequest<TelegramEditedMessage>(
    botToken,
    "editMessageReplyMarkup",
    {
      ...(opts?.inlineMessageId
        ? { inline_message_id: opts.inlineMessageId }
        : (() => {
            if (chatId === undefined || messageId === undefined) {
              throw new Error("chatId and messageId are required when inlineMessageId is not set");
            }
            return { chat_id: chatId, message_id: messageId };
          })()),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    "Failed to edit Telegram message reply markup",
  );
}

export { sendTelegramEditMessageReplyMarkup as editTelegramMessageReplyMarkup };

export async function sendTelegramDeleteMessage(
  botToken: string,
  chatId: string | number,
  messageId: number,
): Promise<true> {
  return telegramJsonRequest<true>(
    botToken,
    "deleteMessage",
    {
      chat_id: chatId,
      message_id: messageId,
    },
    "Failed to delete Telegram message",
  );
}

export { sendTelegramDeleteMessage as deleteTelegramMessage };

function scheduleTelegramReminderCleanup(
  botToken: string,
  chatId: string | number,
  messageId: number,
): void {
  const timer = setTimeout(() => {
    void sendTelegramDeleteMessage(botToken, chatId, messageId).catch((error: unknown) => {
      logger.warn("telegram.reply_reuse_notify_delete_failed", {
        chatId,
        messageId,
        error,
      });
    });
  }, TELEGRAM_REPLY_REUSED_NOTIFICATION_TTL_MS);

  timer.unref?.();
}

function normalizeTelegramDraftText(text: string): string {
  const normalized = text.trim() || "正在处理...";
  if (normalized.length <= MAX_TELEGRAM_DRAFT_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TELEGRAM_DRAFT_TEXT_LENGTH - 1)}…`;
}

export async function sendTelegramMessageDraft(
  botToken: string,
  chatId: string | number,
  draftId: number,
  text: string,
  opts?: {
    signal?: AbortSignal;
  },
): Promise<true> {
  return telegramJsonRequest<true>(
    botToken,
    "sendMessageDraft",
    {
      chat_id: chatId,
      draft_id: draftId,
      text: normalizeTelegramDraftText(text),
    },
    "Failed to send Telegram message draft",
    opts?.signal,
  );
}

async function createUploadFormData(
  chatId: string | number,
  fieldName: "photo" | "document",
  filePath: string,
  opts?: {
    clearDraft?: boolean;
    replyMarkup?: TelegramReplyMarkup;
  },
): Promise<FormData> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (fileStat.size > MAX_TELEGRAM_UPLOAD_BYTES) {
    throw new Error(
      `File exceeds Telegram upload limit: ${path.basename(filePath)} (${fileStat.size} bytes)`,
    );
  }

  const fileBytes = await readFile(filePath);
  const formData = new FormData();
  formData.set("chat_id", String(chatId));
  if (opts?.clearDraft) {
    formData.set("clear_draft", "true");
  }
  if (opts?.replyMarkup) {
    formData.set("reply_markup", JSON.stringify(opts.replyMarkup));
  }
  formData.set(fieldName, new Blob([fileBytes]), path.basename(filePath));
  return formData;
}

export async function sendTelegramPhoto(
  botToken: string,
  chatId: string | number,
  photoPath: string,
  opts?: TelegramSendMediaOptions,
): Promise<TelegramMessage> {
  const formData = await createUploadFormData(chatId, "photo", photoPath, opts);
  return telegramMultipartRequest<TelegramMessage>(
    botToken,
    "sendPhoto",
    formData,
    "Failed to send Telegram photo",
  );
}

export async function sendTelegramDocument(
  botToken: string,
  chatId: string | number,
  documentPath: string,
  opts?: TelegramSendMediaOptions,
): Promise<TelegramMessage> {
  const formData = await createUploadFormData(chatId, "document", documentPath, opts);
  return telegramMultipartRequest<TelegramMessage>(
    botToken,
    "sendDocument",
    formData,
    "Failed to send Telegram document",
  );
}

export async function getTelegramFile(
  botToken: string,
  fileId: string,
): Promise<TelegramFileInfo> {
  return telegramJsonRequest<TelegramFileInfo>(
    botToken,
    "getFile",
    {
      file_id: fileId,
    },
    "Failed to fetch Telegram file metadata",
  );
}

export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  preferredName?: string,
): Promise<{ filePath: string; fileName: string }> {
  const fileInfo = await getTelegramFile(botToken, fileId);
  if (!fileInfo.file_path) {
    throw new Error("Telegram file metadata did not include file_path");
  }

  const safeName = sanitizeIncomingFileName(
    preferredName || path.basename(fileInfo.file_path),
  );
  const response = await undiciFetch(buildFileUrl(botToken, fileInfo.file_path));
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const fileBytes = Buffer.from(await response.arrayBuffer());
  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-telegram-file-"));
  const filePath = path.join(tempDir, safeName);
  await writeFile(filePath, fileBytes);

  logger.info("telegram.file.downloaded", {
    fileId,
    filePath,
    fileName: safeName,
    fileSize: fileBytes.byteLength,
  });

  return {
    filePath,
    fileName: safeName,
  };
}

export function getLargestTelegramPhoto(
  photos: TelegramPhotoSize[],
): TelegramPhotoSize | null {
  if (!photos.length) {
    return null;
  }

  return [...photos].sort((left, right) => {
    const leftSize = left.file_size || left.width * left.height;
    const rightSize = right.file_size || right.width * right.height;
    return rightSize - leftSize;
  })[0] || null;
}

export async function sendTelegramReply(
  botToken: string,
  chatId: string | number,
  reply: string,
  workdir: string,
): Promise<void> {
  await commitTelegramReply(botToken, chatId, reply, workdir);
}

export async function sendTelegramReplyWithMessages(
  botToken: string,
  chatId: string | number,
  reply: string,
  workdir: string,
): Promise<TelegramMessage[]> {
  const result = await commitTelegramReply(botToken, chatId, reply, workdir);
  return result.messages;
}

export async function commitTelegramReply(
  botToken: string,
  chatId: string | number,
  reply: string,
  workdir: string,
  opts?: {
    existingMessage?: TelegramMessage | null;
    finalReplyMode?: TelegramFinalReplyMode;
  },
): Promise<TelegramReplyCommitResult> {
  const payload = parseReplyPayload(reply, workdir);
  payload.text = payload.text ? sanitizeTelegramReplyText(payload.text) : payload.text;
  const sentMessages: TelegramMessage[] = [];
  const isPureText = Boolean(payload.text)
    && payload.imagePaths.length === 0
    && payload.filePaths.length === 0;

  if (isPureText && opts?.existingMessage) {
    const edited = await sendTelegramEditMessageText(
      botToken,
      opts.existingMessage.chat.id,
      opts.existingMessage.message_id,
      payload.text,
    );
    const editedMessage = edited === true
      ? {
          ...opts.existingMessage,
          text: payload.text,
          caption: undefined,
          photo: undefined,
          document: undefined,
        }
      : edited;
    const result: TelegramReplyCommitResult = {
      messages: [editedMessage],
      reusedExistingMessage: true,
    };

    if (opts?.finalReplyMode === "replace_and_notify") {
      sendTelegramMessage(
        botToken,
        chatId,
        TELEGRAM_REPLY_REUSED_NOTIFICATION_TEXT,
        {
          clearDraft: true,
          replyToMessageId: editedMessage.message_id,
        },
      )
        .then((notificationMessage) => {
          scheduleTelegramReminderCleanup(
            botToken,
            chatId,
            notificationMessage.message_id,
          );
        })
        .catch((error) => {
          logger.warn("telegram.reply_reuse_notify_failed", {
            chatId,
            messageId: editedMessage.message_id,
            error,
          });
        });
    }

    return result;
  }

  if (payload.text) {
    sentMessages.push(
      await sendTelegramMessage(botToken, chatId, payload.text, { clearDraft: true }),
    );
  } else if (payload.imagePaths.length > 0 || payload.filePaths.length > 0) {
    sentMessages.push(
      await sendTelegramMessage(botToken, chatId, "See below.", { clearDraft: true }),
    );
  }

  for (const imagePath of payload.imagePaths) {
    sentMessages.push(
      await sendTelegramPhoto(botToken, chatId, imagePath, { clearDraft: true }),
    );
  }

  for (const filePath of payload.filePaths) {
    sentMessages.push(
      await sendTelegramDocument(botToken, chatId, filePath, { clearDraft: true }),
    );
  }

  if (!payload.text && payload.imagePaths.length === 0 && payload.filePaths.length === 0) {
    sentMessages.push(
      await sendTelegramMessage(botToken, chatId, reply, { clearDraft: true }),
    );
  }

  return {
    messages: sentMessages,
    reusedExistingMessage: false,
  };
}



import { readFile, stat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Blob } from "node:buffer";
import { fetch as undiciFetch, FormData } from "undici";

import { parseReplyPayload, sanitizeIncomingFileName } from "./message.js";
import { logger } from "./logger.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_DOWNLOAD_BASE = "https://api.telegram.org/file";
const MAX_TELEGRAM_UPLOAD_BYTES = 49 * 1024 * 1024;
const MAX_TELEGRAM_DRAFT_TEXT_LENGTH = 4096;

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

function normalizeTelegramDraftText(text: string): string {
  const normalized = text.trim() || "正在处理…";
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
  const payload = parseReplyPayload(reply, workdir);

  if (payload.text) {
    await sendTelegramMessage(botToken, chatId, payload.text, { clearDraft: true });
  } else if (payload.imagePaths.length > 0 || payload.filePaths.length > 0) {
    await sendTelegramMessage(botToken, chatId, "请查收~", { clearDraft: true });
  }

  for (const imagePath of payload.imagePaths) {
    await sendTelegramPhoto(botToken, chatId, imagePath, { clearDraft: true });
  }

  for (const filePath of payload.filePaths) {
    await sendTelegramDocument(botToken, chatId, filePath, { clearDraft: true });
  }

  if (!payload.text && payload.imagePaths.length === 0 && payload.filePaths.length === 0) {
    await sendTelegramMessage(botToken, chatId, reply, { clearDraft: true });
  }
}

export async function sendTelegramReplyWithMessages(
  botToken: string,
  chatId: string | number,
  reply: string,
  workdir: string,
): Promise<TelegramMessage[]> {
  const payload = parseReplyPayload(reply, workdir);
  const sentMessages: TelegramMessage[] = [];

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

  return sentMessages;
}

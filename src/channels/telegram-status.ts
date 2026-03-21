import type { ProviderRuntimeEvent } from "../providers/index.js";

export const TELEGRAM_STATUS_UPDATE_THROTTLE_MS = 1_500;

export const TELEGRAM_RECEIVED_STATUS_TEXT = "已收到消息";
export const TELEGRAM_IMAGE_STATUS_TEXT = "正在理解图片";
export const TELEGRAM_RUNNING_STATUS_TEXT = "正在理解问题";
export const TELEGRAM_COMMAND_STATUS_TEXT = "正在执行命令";
export const TELEGRAM_WEB_STATUS_TEXT = "正在搜索网页";
export const TELEGRAM_TOOL_STATUS_TEXT = "正在调用工具";
export const TELEGRAM_FILE_STATUS_TEXT = "正在修改文件";
export const TELEGRAM_FINALIZING_STATUS_TEXT = "正在整理回复";
export const TELEGRAM_REPAIRING_STATUS_TEXT = "正在补全查询结果";
export const TELEGRAM_SENDING_STATUS_TEXT = "正在发送回复";

export type TelegramRuntimeStatusPhase =
  | "received"
  | "processing"
  | "sending";

export type TelegramRuntimeStatus = {
  phase: TelegramRuntimeStatusPhase;
  text: string;
};

const DETAIL_SEPARATOR = "：";
const COMMAND_DETAIL_MAX_LENGTH = 24;
const QUERY_DETAIL_MAX_LENGTH = 32;
const TOOL_DETAIL_MAX_LENGTH = 32;

function normalizeDetail(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateDetail(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 3))}...`;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "");
}

function sanitizePathLikeToken(value: string): string {
  const cleaned = stripWrappingQuotes(value);
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : cleaned;
}

function appendDetail(baseText: string, detail?: string): string {
  const preview = normalizeDetail(detail);
  return preview ? `${baseText}${DETAIL_SEPARATOR}${preview}` : baseText;
}

function sanitizeCommandDetail(command?: string): string | undefined {
  const normalized = normalizeDetail(command);
  if (!normalized) {
    return undefined;
  }

  const tokens = normalized.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  if (tokens.length === 0) {
    return undefined;
  }

  const commandName = sanitizePathLikeToken(tokens[0]!);
  if (!commandName) {
    return undefined;
  }

  const secondToken = tokens[1]
    ? stripWrappingQuotes(tokens[1]!)
    : undefined;
  const includeSecondToken = Boolean(
    secondToken
    && /^[a-z][a-z0-9:_-]{0,15}$/i.test(secondToken)
    && !secondToken.startsWith("-")
    && !/[\\/]/.test(secondToken)
    && !/^https?:\/\//i.test(secondToken),
  );

  return truncateDetail(
    includeSecondToken ? `${commandName} ${secondToken}` : commandName,
    COMMAND_DETAIL_MAX_LENGTH,
  );
}

function sanitizeQueryDetail(query?: string): string | undefined {
  const normalized = normalizeDetail(query);
  if (!normalized) {
    return undefined;
  }

  const withoutUrls = normalized.replace(/https?:\/\/\S+/gi, "").trim();
  if (!withoutUrls) {
    return undefined;
  }

  const words = withoutUrls.split(/\s+/).slice(0, 6).join(" ");
  return truncateDetail(words, QUERY_DETAIL_MAX_LENGTH);
}

function sanitizeToolDetail(toolName?: string): string | undefined {
  const normalized = normalizeDetail(toolName);
  if (!normalized) {
    return undefined;
  }

  return truncateDetail(sanitizePathLikeToken(normalized), TOOL_DETAIL_MAX_LENGTH);
}

export function buildTelegramRunningStatus(): TelegramRuntimeStatus {
  return {
    phase: "processing",
    text: TELEGRAM_RUNNING_STATUS_TEXT,
  };
}

export function buildTelegramImageStatus(): TelegramRuntimeStatus {
  return {
    phase: "processing",
    text: TELEGRAM_IMAGE_STATUS_TEXT,
  };
}

export function buildTelegramCommandStatus(command?: string): string {
  return appendDetail(TELEGRAM_COMMAND_STATUS_TEXT, sanitizeCommandDetail(command));
}

export function buildTelegramWebStatus(query?: string): string {
  return appendDetail(TELEGRAM_WEB_STATUS_TEXT, sanitizeQueryDetail(query));
}

export function buildTelegramToolStatus(toolName?: string): string {
  return appendDetail(TELEGRAM_TOOL_STATUS_TEXT, sanitizeToolDetail(toolName));
}

export function buildTelegramFileStatus(): TelegramRuntimeStatus {
  return {
    phase: "processing",
    text: TELEGRAM_FILE_STATUS_TEXT,
  };
}

export function buildTelegramFinalizingStatus(): TelegramRuntimeStatus {
  return {
    phase: "processing",
    text: TELEGRAM_FINALIZING_STATUS_TEXT,
  };
}

export function buildTelegramRepairingStatus(): TelegramRuntimeStatus {
  return {
    phase: "processing",
    text: TELEGRAM_REPAIRING_STATUS_TEXT,
  };
}

export function buildTelegramSendingStatus(): TelegramRuntimeStatus {
  return {
    phase: "sending",
    text: TELEGRAM_SENDING_STATUS_TEXT,
  };
}

function isLifecycleStartEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "thread.started" || event.type === "turn.started";
}

function isWorkItemEvent(event: ProviderRuntimeEvent): boolean {
  return (event.type === "item.started" || event.type === "item.completed") && Boolean(event.itemType);
}

export function getTelegramStatusPhaseRank(phase: TelegramRuntimeStatusPhase): number {
  switch (phase) {
    case "received":
      return 0;
    case "processing":
      return 1;
    case "sending":
      return 2;
    default:
      return -1;
  }
}

export function mapProviderEventToTelegramStatus(
  event: ProviderRuntimeEvent,
): TelegramRuntimeStatus | null {
  if (isLifecycleStartEvent(event)) {
    return buildTelegramRunningStatus();
  }

  if (event.type === "reply.repair.started") {
    return buildTelegramRepairingStatus();
  }

  if (!isWorkItemEvent(event)) {
    return null;
  }

  switch (event.itemType) {
    case "command_execution":
      return {
        phase: "processing",
        text: buildTelegramCommandStatus(event.command),
      };
    case "web_search":
      return {
        phase: "processing",
        text: buildTelegramWebStatus(event.query),
      };
    case "mcp_tool_call":
      return {
        phase: "processing",
        text: buildTelegramToolStatus(event.toolName),
      };
    case "file_change":
      return buildTelegramFileStatus();
    case "plan_update":
    case "reasoning":
      return buildTelegramRunningStatus();
    case "agent_message":
      if (event.type !== "item.completed") {
        return null;
      }
      return buildTelegramFinalizingStatus();
    default:
      return null;
  }
}

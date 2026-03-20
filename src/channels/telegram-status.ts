import type { ProviderRuntimeEvent } from "../providers/index.js";

export const TELEGRAM_STATUS_UPDATE_THROTTLE_MS = 1_500;

export const TELEGRAM_RECEIVED_STATUS_TEXT = "已收到消息";
export const TELEGRAM_RUNNING_STATUS_TEXT = "正在理解问题";
export const TELEGRAM_COMMAND_STATUS_TEXT = "正在执行命令";
export const TELEGRAM_WEB_STATUS_TEXT = "正在搜索网页";
export const TELEGRAM_TOOL_STATUS_TEXT = "正在调用工具";
export const TELEGRAM_FILE_STATUS_TEXT = "正在修改文件";
export const TELEGRAM_FINALIZING_STATUS_TEXT = "正在整理回复";
export const TELEGRAM_SENDING_STATUS_TEXT = "正在发送回复";

export type TelegramRuntimeStatusPhase =
  | "received"
  | "processing"
  | "sending";

export type TelegramRuntimeStatus = {
  phase: TelegramRuntimeStatusPhase;
  text: string;
};

const DETAIL_MAX_LENGTH = 48;

function normalizeDetail(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= DETAIL_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, DETAIL_MAX_LENGTH - 1)}...`;
}

function appendDetail(baseText: string, detail?: string): string {
  const preview = normalizeDetail(detail);
  return preview ? `${baseText}：${preview}` : baseText;
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
  if (event.type === "thread.started" || event.type === "turn.started") {
    return {
      phase: "processing",
      text: TELEGRAM_RUNNING_STATUS_TEXT,
    };
  }

  const isWorkEvent = event.type === "item.started" || event.type === "item.completed";
  if (!isWorkEvent || !event.itemType) {
    return null;
  }

  switch (event.itemType) {
    case "command_execution":
      return {
        phase: "processing",
        text: appendDetail(TELEGRAM_COMMAND_STATUS_TEXT, event.command),
      };
    case "web_search":
      return {
        phase: "processing",
        text: appendDetail(TELEGRAM_WEB_STATUS_TEXT, event.query),
      };
    case "mcp_tool_call":
      return {
        phase: "processing",
        text: appendDetail(TELEGRAM_TOOL_STATUS_TEXT, event.toolName),
      };
    case "file_change":
      return {
        phase: "processing",
        text: appendDetail(TELEGRAM_FILE_STATUS_TEXT, event.aggregatedOutputPreview),
      };
    case "plan_update":
    case "reasoning":
      return {
        phase: "processing",
        text: TELEGRAM_RUNNING_STATUS_TEXT,
      };
    case "agent_message":
      if (event.type !== "item.completed") {
        return null;
      }
      return {
        phase: "processing",
        text: TELEGRAM_FINALIZING_STATUS_TEXT,
      };
    default:
      return null;
  }
}

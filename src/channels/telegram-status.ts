import type { ProviderRuntimeEvent } from "../providers/index.js";

export const TELEGRAM_STATUS_UPDATE_THROTTLE_MS = 1_500;

export const TELEGRAM_RECEIVED_STATUS_TEXT = "已收到消息";
export const TELEGRAM_IMAGE_STATUS_TEXT = "正在理解图片";
export const TELEGRAM_RUNNING_STATUS_TEXT = "正在理解问题";
export const TELEGRAM_COMMAND_STATUS_TEXT = "正在执行命令";
export const TELEGRAM_WEB_STATUS_TEXT = "正在搜索网页";
export const TELEGRAM_TOOL_STATUS_TEXT = "正在调用工具";
export const TELEGRAM_FILE_STATUS_TEXT = "正在修改文件";
export const TELEGRAM_PLAN_STATUS_TEXT = "当前计划";
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

export type TelegramPlanFallbackContext = {
  itemType?: string;
  command?: string;
  toolName?: string;
  query?: string;
  text?: string;
};

const DETAIL_SEPARATOR = "：";
const COMMAND_DETAIL_MAX_LENGTH = 24;
const QUERY_DETAIL_MAX_LENGTH = 32;
const TOOL_DETAIL_MAX_LENGTH = 32;
const TODO_STEP_MAX_LENGTH = 28;
const TODO_DETAIL_MAX_LENGTH = 36;

type TelegramPlanStage =
  | "analysis"
  | "research"
  | "code_review"
  | "modification"
  | "verification"
  | "tool"
  | "finalizing";

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

function sanitizePlanQueryDetail(query?: string): string | undefined {
  const normalized = normalizeDetail(query);
  if (!normalized) {
    return undefined;
  }

  const withoutUrls = normalized.replace(/https?:\/\/\S+/gi, "").trim();
  if (!withoutUrls) {
    return undefined;
  }

  const allWords = withoutUrls.split(/\s+/);
  const words = allWords.slice(0, 4).join(" ");
  const detail = sanitizePlanDetail(words);
  if (!detail) {
    return undefined;
  }

  return allWords.length > 4 ? `${detail}...` : detail;
}

function sanitizeTodoStep(step?: string): string | undefined {
  const normalized = normalizeDetail(step);
  if (!normalized) {
    return undefined;
  }

  return truncateDetail(stripWrappingQuotes(normalized), TODO_STEP_MAX_LENGTH);
}

function sanitizePlanDetail(detail?: string): string | undefined {
  const normalized = normalizeDetail(detail);
  if (!normalized) {
    return undefined;
  }

  return truncateDetail(normalized, TODO_DETAIL_MAX_LENGTH);
}

function stripUrlsAndPaths(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[A-Za-z]:\\[^\s,;:：，；]+/g, " ")
    .replace(/(?:^|\s)\/[^\s,;:：，；]+/g, " ");
}

function translateTodoDetail(value: string): string {
  return value
    .replace(/\btelegram\b/gi, "Telegram")
    .replace(/\bstatus pipeline\b/gi, "状态链路")
    .replace(/\bstatus flow\b/gi, "状态流转")
    .replace(/\bstatus transition\b/gi, "状态流转")
    .replace(/\bplan summary\b/gi, "计划摘要")
    .replace(/\bchinese\b/gi, "中文")
    .replace(/\bsummary\b/gi, "摘要")
    .replace(/\bprompt\b/gi, "提示词")
    .replace(/\breply\b/gi, "回复")
    .replace(/\bresult\b/gi, "结果")
    .replace(/\bruntime\b/gi, "运行状态")
    .replace(/\btimeout\b/gi, "超时")
    .replace(/中文\s+计划摘要/gu, "中文计划摘要");
}

function stripLeadingTodoAction(value: string): string {
  return value.replace(
    /^(?:summarize|summary|draft|prepare|write|inspect|read|review|search|check|trace|analyze|understand|interpret|determine|investigate|research|browse|fetch|edit|modify|update|fix|implement|patch|run|verify|test|validate|整理|总结|撰写|准备|输出|返回|检查|查看|搜索|查找|查阅|读取|分析|理解|确认|定位|修改|修复|更新|实现|运行|验证|测试)\s+(?:the\s+)?/iu,
    "",
  );
}

function splitTodoDetailCandidate(value: string): string {
  return value
    .split(/\b(?:for|to|and then|and|while|after|before|with)\b|，|。|；|：|,|;|:|并且|然后|用于|避免|确保/u)[0]!
    .trim();
}

function extractTodoDetail(value?: string): string | undefined {
  const normalized = normalizeDetail(value);
  if (!normalized) {
    return undefined;
  }

  const withoutNoise = stripUrlsAndPaths(stripLeadingTodoAction(stripWrappingQuotes(normalized)))
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutNoise) {
    return undefined;
  }

  const translated = translateTodoDetail(splitTodoDetailCandidate(withoutNoise))
    .replace(/\b(?:user-facing|internal|current|latest|task|step|status)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return sanitizePlanDetail(translated);
}

function buildPlanStageText(stage: TelegramPlanStage, detail?: string): string {
  const baseText = stage === "analysis"
    ? "正在分析问题"
    : stage === "research"
      ? "正在查资料"
      : stage === "code_review"
        ? "正在检查代码"
        : stage === "modification"
          ? "正在修改实现"
          : stage === "verification"
            ? "正在运行检查"
            : stage === "tool"
              ? "正在调用工具"
              : "正在整理结果";

  return appendDetail(baseText, sanitizePlanDetail(detail));
}

function detectTodoStage(value?: string): TelegramPlanStage | null {
  const normalized = normalizeDetail(value);
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (/(整理|总结|撰写|回复|结果|答案|输出|summari|draft|response|reply|answer|final)/iu.test(lowered)) {
    return "finalizing";
  }
  if (/(查资料|网页|搜索|查询|公开信息|web|browse|search|lookup|research|fetch|latest)/iu.test(lowered)) {
    return "research";
  }
  if (/(修改|修复|更新|实现|patch|edit|modify|update|fix|implement|write code)/iu.test(lowered)) {
    return "modification";
  }
  if (/(测试|验证|编译|构建|lint|check|verify|test|build|compile|npm run|tsc|pytest)/iu.test(lowered)) {
    return "verification";
  }
  if (/(工具|mcp|tool)/iu.test(lowered)) {
    return "tool";
  }
  if (/(代码|文件|实现|仓库|repo|code|file|implementation|module|pipeline|state)/iu.test(lowered)) {
    return "code_review";
  }
  if (/(分析|理解|计划|判断|确认|interpret|understand|analy|determine|plan)/iu.test(lowered)) {
    return "analysis";
  }

  return null;
}

function buildTodoStageSummary(step?: string): string | undefined {
  const stage = detectTodoStage(step);
  if (!stage) {
    return undefined;
  }

  const detail = extractTodoDetail(step);
  return buildPlanStageText(stage, detail);
}

function buildFallbackPlanSummary(context?: TelegramPlanFallbackContext): string | undefined {
  if (!context?.itemType) {
    return undefined;
  }

  switch (context.itemType) {
    case "web_search":
      return buildPlanStageText("research", sanitizePlanQueryDetail(context.query));
    case "command_execution":
      return buildPlanStageText("verification", sanitizeCommandDetail(context.command));
    case "mcp_tool_call":
      return buildPlanStageText("tool", sanitizeToolDetail(context.toolName));
    case "file_change":
      return buildPlanStageText("modification");
    case "reasoning":
    case "plan_update":
      return buildPlanStageText("analysis", extractTodoDetail(context.text));
    default:
      return undefined;
  }
}

export function buildTelegramPlanFallbackContext(event: ProviderRuntimeEvent): TelegramPlanFallbackContext | null {
  switch (event.itemType) {
    case "command_execution":
      return {
        itemType: event.itemType,
        command: event.command,
      };
    case "web_search":
      return {
        itemType: event.itemType,
        query: event.query,
      };
    case "mcp_tool_call":
      return {
        itemType: event.itemType,
        toolName: event.toolName,
      };
    case "file_change":
    case "reasoning":
    case "plan_update":
      return {
        itemType: event.itemType,
        text: event.text,
      };
    default:
      return null;
  }
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

export function buildTelegramPlanStatus(
  completed?: number,
  total?: number,
  currentStep?: string,
  fallbackContext?: TelegramPlanFallbackContext,
): string {
  if (
    typeof completed !== "number"
    || !Number.isFinite(completed)
    || typeof total !== "number"
    || !Number.isFinite(total)
    || total <= 0
  ) {
    return TELEGRAM_RUNNING_STATUS_TEXT;
  }

  const summary = `${TELEGRAM_PLAN_STATUS_TEXT}${DETAIL_SEPARATOR}${completed}/${total} 已完成`;
  const stepPreview = buildTodoStageSummary(currentStep)
    || buildFallbackPlanSummary(fallbackContext)
    || sanitizeTodoStep(currentStep);
  return stepPreview ? `${summary}；当前步骤：${stepPreview}` : summary;
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
  fallbackContext?: TelegramPlanFallbackContext,
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
    case "todo_list":
      return {
        phase: "processing",
        text: buildTelegramPlanStatus(event.todoCompleted, event.todoTotal, event.todoCurrentStep, fallbackContext),
      };
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

import type { CodexJsonEvent } from "../types.js";
import type { ProviderProgressKind, ProviderRuntimeEvent } from "./types.js";

export const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_PROVIDER_LONG_STEP_STALL_TIMEOUT_MS = 600_000;
export const DEFAULT_PROVIDER_MAX_RUNTIME_MS = 3_600_000;

export const PROVIDER_PROGRESS_ITEM_TYPES = new Set([
  "command_execution",
  "web_search",
  "mcp_tool_call",
  "file_change",
  "todo_list",
  "plan_update",
  "reasoning",
  "agent_message",
]);

export const PROVIDER_LONG_STEP_ITEM_TYPES = new Set([
  "command_execution",
  "web_search",
  "mcp_tool_call",
  "file_change",
]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const flattened = value
      .map((entry) => toTrimmedString(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (flattened.length > 0) {
      return flattened.join(" ");
    }
  }

  return undefined;
}

function getByPath(record: UnknownRecord | null, path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    const next = asRecord(current);
    if (!next || !(key in next)) {
      return undefined;
    }
    current = next[key];
  }
  return current;
}

function firstString(record: UnknownRecord | null, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = getByPath(record, path);
    const text = toTrimmedString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function buildPreview(value: string | undefined, maxLength: number = 80): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxLength - 1))}...`;
}

function getItem(event: CodexJsonEvent): UnknownRecord | null {
  return asRecord(event.item);
}

function getItemText(item: UnknownRecord | null): string | undefined {
  return firstString(item, [
    ["text"],
    ["content"],
    ["message"],
    ["output_text"],
  ]);
}

function getCommand(item: UnknownRecord | null): string | undefined {
  return firstString(item, [
    ["command"],
    ["input", "command"],
    ["arguments", "command"],
  ]);
}

function getToolName(item: UnknownRecord | null): string | undefined {
  return firstString(item, [
    ["toolName"],
    ["tool_name"],
    ["tool", "name"],
    ["call", "name"],
    ["name"],
  ]);
}

function getQuery(item: UnknownRecord | null): string | undefined {
  return firstString(item, [
    ["query"],
    ["search_query"],
    ["searchQuery"],
    ["input", "query"],
    ["input", "search_query"],
    ["input", "searchQuery"],
  ]);
}

function getAggregatedOutput(item: UnknownRecord | null): string | undefined {
  return firstString(item, [
    ["aggregated_output"],
    ["aggregatedOutput"],
    ["output"],
    ["stderr"],
    ["stdout"],
  ]);
}

function getTodoSummary(item: UnknownRecord | null): Pick<ProviderRuntimeEvent, "todoCompleted" | "todoTotal" | "todoCurrentStep"> {
  if (toTrimmedString(item?.type) !== "todo_list" || !Array.isArray(item?.items)) {
    return {};
  }

  let todoTotal = 0;
  let todoCompleted = 0;
  let todoCurrentStep: string | undefined;

  for (const entry of item.items) {
    const todo = asRecord(entry);
    if (!todo) {
      continue;
    }

    todoTotal += 1;
    const completed = todo.completed === true;
    if (completed) {
      todoCompleted += 1;
      continue;
    }

    if (!todoCurrentStep) {
      todoCurrentStep = firstString(todo, [["text"], ["content"], ["title"]]);
    }
  }

  return {
    todoCompleted: todoTotal > 0 ? todoCompleted : undefined,
    todoTotal: todoTotal > 0 ? todoTotal : undefined,
    todoCurrentStep,
  };
}

function classifyProgressKind(type: string, itemType?: string): ProviderProgressKind {
  if (type === "turn.failed" || type === "error") {
    return "terminal";
  }

  if (
    type === "thread.started"
    || type === "turn.started"
    || type === "turn.completed"
    || ((type === "item.started" || type === "item.completed") && itemType && PROVIDER_PROGRESS_ITEM_TYPES.has(itemType))
  ) {
    return "progress";
  }

  return "informational";
}

export function normalizeProviderRuntimeEvent(event: CodexJsonEvent): ProviderRuntimeEvent {
  const item = getItem(event);
  const itemType = toTrimmedString(item?.type);
  const todoSummary = getTodoSummary(item);

  return {
    type: toTrimmedString(event.type) || "unknown",
    threadId: toTrimmedString(event.thread_id),
    itemId: toTrimmedString(item?.id),
    itemType,
    itemStatus: firstString(item, [["status"], ["state"]]),
    text: getItemText(item),
    command: getCommand(item),
    toolName: getToolName(item),
    query: getQuery(item),
    ...todoSummary,
    aggregatedOutputPreview: buildPreview(getAggregatedOutput(item), 120),
    progressKind: classifyProgressKind(toTrimmedString(event.type) || "unknown", itemType),
    raw: event,
  };
}

export function isProviderProgressEvent(event: ProviderRuntimeEvent): boolean {
  return event.progressKind === "progress";
}

export function isProviderLongStepItemType(itemType?: string): boolean {
  return Boolean(itemType && PROVIDER_LONG_STEP_ITEM_TYPES.has(itemType));
}

export function getProviderLongStepKey(event: ProviderRuntimeEvent): string | null {
  if (!isProviderLongStepItemType(event.itemType)) {
    return null;
  }

  return event.itemId || `anonymous:${event.itemType}`;
}

export function shouldTriggerProviderIdleTimeout(
  lastProgressAt: number,
  activeLongStepCount: number,
  now: number,
  idleTimeoutMs: number,
): boolean {
  if (idleTimeoutMs <= 0 || activeLongStepCount > 0) {
    return false;
  }

  return now - lastProgressAt >= idleTimeoutMs;
}

export function shouldTriggerProviderLongStepStallTimeout(
  lastRuntimeEventAt: number,
  activeLongStepCount: number,
  now: number,
  longStepStallTimeoutMs: number,
): boolean {
  if (longStepStallTimeoutMs <= 0 || activeLongStepCount <= 0) {
    return false;
  }

  return now - lastRuntimeEventAt >= longStepStallTimeoutMs;
}

import type { RunResult } from "./providers/index.js";

export class ProviderIncompleteReplyError extends Error {
  readonly replyText: string;

  constructor(replyText: string) {
    super("Provider completed with a progress-only reply instead of a final answer");
    this.name = "ProviderIncompleteReplyError";
    this.replyText = replyText;
  }
}

export interface EnsureCompletedUserReplyOptions {
  userText: string;
  result: RunResult;
  sessionIdFallback?: string | null;
  continueRun?: (sessionId: string, prompt: string) => Promise<RunResult>;
}

export interface EnsureCompletedUserReplyResult {
  result: RunResult;
  repaired: boolean;
}

const LOOKUP_TASK_PATTERNS = [
  /[?？]/,
  /\b(?:search|look up|lookup|check|verify|confirm|find|latest|current|today|weather|price|rate|news|what|who|where|when|why|how)\b/i,
  /(查|查询|搜索|搜一下|搜下|搜|看看|看下|看一下|确认|核实|验证|天气|价格|汇率|最新|现在|今天|多少|什么|是谁|谁是|哪里|在哪|怎么|是否)/,
];

const ECHO_STYLE_REPLY_PATTERNS = [
  /\b(?:reply|respond|say|output)\b[\s\S]*\bexactly\b/i,
  /(?:只)?(?:回复|输出|说)[\s\S]*(?:原样|一字不差|exactly)/,
];

const PROGRESS_ONLY_REPLY_PATTERNS = [
  /^(?:one moment|hold on|give me a moment)(?: while i)?(?: check| look(?: that| this| it)? up| verify| confirm| search)?$/i,
  /^(?:i(?: am|')?ll|i will|let me|i need to)\s+(?:check|look(?: that| this| it)? up|verify|confirm|search|find out)(?:\s+(?:that|this|it|for you))?(?:\s+first)?$/i,
  /^(?:checking|looking(?: that| this| it)? up|verifying|confirming)(?:\s+now)?$/i,
  /^(?:稍等(?:一下)?\s*)?(?:(?:我|我先|我去|我来|让我)\s*)?(?:先\s*)?(?:查|确认|核实|看|看看|搜|搜索|找)(?:\s*(?:一下|下))?(?:\s*(?:这|这个|这件事|这个问题|情况))?(?:\s*(?:再|后))?(?:\s*(?:回复你|告诉你))?$/i,
];

function normalizeForDetection(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]/g, " ")
    .replace(/[“”"'‘’]/g, "")
    .replace(/[.,，。！？!?、,:：；;()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyLookupTask(userText: string): boolean {
  const normalized = normalizeForDetection(userText);
  if (!normalized) {
    return false;
  }

  if (ECHO_STYLE_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return LOOKUP_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function looksLikeProgressOnlyReply(replyText: string): boolean {
  const normalized = normalizeForDetection(replyText);
  if (!normalized || normalized.length > 80) {
    return false;
  }

  return PROGRESS_ONLY_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldRepairIncompleteReply(userText: string, replyText: string): boolean {
  return isLikelyLookupTask(userText) && looksLikeProgressOnlyReply(replyText);
}

export function buildIncompleteReplyRecoveryPrompt(userText: string, partialReply: string): string {
  return [
    "The previous assistant turn ended with only a progress update and did not answer the user.",
    `Progress-only text: ${JSON.stringify(partialReply.trim())}`,
    "Continue the same task in this session and send the final answer now.",
    "If you still need to check something, do that work first and only answer once you have the result.",
    "Do not send another placeholder such as 'I'll check', 'let me confirm', or similar progress-only text.",
    "",
    "Original user request:",
    userText.trim(),
  ].join("\n");
}

export async function ensureCompletedUserReply(
  options: EnsureCompletedUserReplyOptions,
): Promise<EnsureCompletedUserReplyResult> {
  const {
    userText,
    result,
    sessionIdFallback,
    continueRun,
  } = options;

  if (!shouldRepairIncompleteReply(userText, result.text)) {
    return {
      result,
      repaired: false,
    };
  }

  const sessionId = result.sessionId || sessionIdFallback || null;
  if (!sessionId || !continueRun) {
    throw new ProviderIncompleteReplyError(result.text);
  }

  const repairedResult = await continueRun(
    sessionId,
    buildIncompleteReplyRecoveryPrompt(userText, result.text),
  );

  if (looksLikeProgressOnlyReply(repairedResult.text)) {
    throw new ProviderIncompleteReplyError(repairedResult.text);
  }

  return {
    result: repairedResult,
    repaired: true,
  };
}

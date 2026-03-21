import type { RunResult } from "./providers/index.js";

export class ProviderIncompleteReplyError extends Error {
  readonly replyText: string;

  constructor(replyText: string) {
    super("Provider completed with a progress-only or unresolved lookup reply instead of a final answer");
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
  /(?:只|请只)?(?:回复|输出|说)[\s\S]*(?:原样|一字不差|exactly)/,
];

const STRICT_PROGRESS_ONLY_REPLY_PATTERNS = [
  /^(?:one moment|hold on|give me a moment)(?: while i)?(?: check| look(?: that| this| it)? up| verify| confirm| search)?$/i,
  /^(?:i(?: am|')?ll|i will|let me|i need to)\s+(?:check|look(?: that| this| it)? up|verify|confirm|search|find out)(?:\s+(?:that|this|it|for you))?(?:\s+first)?$/i,
  /^(?:checking|looking(?: that| this| it)? up|verifying|confirming)(?:\s+now)?$/i,
  /^(?:我先|我去|我来|让我)?(?:查一下|查下|看一下|看下|确认一下|确认下|核实一下|核实下|搜一下|搜下|搜索一下)$/,
  /^(?:稍等|等我一下|等下)(?:我)?(?:查一下|确认一下|核实一下|看一下)?$/,
];

const PROGRESS_REPLY_PREFIXES = [
  "i will check",
  "i will look up",
  "i will verify",
  "i will confirm",
  "i'll check",
  "i'll look up",
  "i'll verify",
  "i'll confirm",
  "let me check",
  "let me look up",
  "let me verify",
  "let me confirm",
  "checking",
  "looking it up",
  "looking this up",
  "verifying",
  "confirming",
  "one moment",
  "hold on",
  "give me a moment",
  "我先查一下",
  "我先查下",
  "我先看一下",
  "我先看下",
  "我先确认一下",
  "我先确认下",
  "我先核实一下",
  "我先核实下",
  "我先搜一下",
  "我先搜下",
  "我先搜索一下",
  "我去查一下",
  "我去查下",
  "我去确认一下",
  "我去核实一下",
  "我来查一下",
  "让我查一下",
  "稍等我查一下",
  "稍等我确认一下",
  "稍等我核实一下",
];

const ANSWER_SIGNAL_PATTERNS = [
  /\b(?:is|are|was|were|means|refers to|founded|located|current|according to|it is)\b/i,
  /https?:\/\//i,
  /\d/,
  /(是一个|是一家|是由|位于|根据|官网显示|官方资料|目前价格|当前天气|当前温度|当前汇率|叫做|属于)/,
];

const EXPLICIT_FAILURE_PATTERNS = [
  /\b(?:unable to|cannot|can't|could not|couldn't|failed to|not available|no access|timed out|unavailable)\b/i,
  /\b(?:i don'?t have access|i can'?t access|i couldn'?t verify|i can'?t verify)\b/i,
  /(无法|不能|没法|未能|失败|超时|没有权限|无权限|无法访问|不能访问|无法查询|无法确认|未找到可靠来源|没有可靠来源|接口不可用|网络不可用|当前无法联网)/,
];

const WEAK_NON_ANSWER_PATTERNS = [
  /^(?:i dont know|not sure|unclear|unknown|im not sure|i am not sure|i cannot confirm that)$/i,
  /^(?:\u4e0d\u77e5\u9053|\u4e0d\u786e\u5b9a|\u4e0d\u6e05\u695a|\u6ca1\u67e5\u5230|\u67e5\u4e0d\u5230|\u65e0\u6cd5\u786e\u8ba4|\u4e0d\u597d\u8bf4|\u8bf4\u4e0d\u597d)$/u,
];

function normalizeForDetection(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]/g, " ")
    .replace(/[“”"'‘’]/g, "")
    .replace(/[.,，。！？?、:：；;()[\]{}]/g, " ")
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
  if (!normalized) {
    return false;
  }

  if (
    normalized.length <= 80
    && STRICT_PROGRESS_ONLY_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }

  const lower = normalized.toLowerCase();
  const hasProgressPrefix = PROGRESS_REPLY_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!hasProgressPrefix) {
    return false;
  }

  if (lower.includes("i checked") || lower.includes("i looked up") || normalized.includes("我查了一下")) {
    return false;
  }

  return !ANSWER_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function looksLikeExplicitFailureReply(replyText: string): boolean {
  const normalized = normalizeForDetection(replyText);
  if (!normalized) {
    return false;
  }

  return EXPLICIT_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function looksLikeWeakNonAnswerReply(replyText: string): boolean {
  const normalized = normalizeForDetection(replyText);
  if (!normalized) {
    return false;
  }

  if (looksLikeProgressOnlyReply(normalized) || looksLikeExplicitFailureReply(normalized)) {
    return false;
  }

  const collapsed = normalized.toLowerCase().replace(/\s+/g, " ").trim();
  if (WEAK_NON_ANSWER_PATTERNS.some((pattern) => pattern.test(collapsed))) {
    return true;
  }

  return /^(?:\s*)(?:\u4e0d\u77e5\u9053|\u4e0d\u786e\u5b9a|\u4e0d\u6e05\u695a|\u6ca1\u67e5\u5230|\u67e5\u4e0d\u5230|\u65e0\u6cd5\u786e\u8ba4|\u4e0d\u597d\u8bf4|\u8bf4\u4e0d\u597d)(?:\s*[。！？?]?)(?:\s*)$/u.test(replyText);
}

export function shouldRepairIncompleteReply(userText: string, replyText: string): boolean {
  if (!isLikelyLookupTask(userText)) {
    return false;
  }

  return looksLikeProgressOnlyReply(replyText) || looksLikeWeakNonAnswerReply(replyText);
}

export function buildIncompleteReplyRecoveryPrompt(userText: string, partialReply: string): string {
  return [
    "The previous assistant turn ended without a usable final answer for the user.",
    `Incomplete text: ${JSON.stringify(partialReply.trim())}`,
    "Continue the same task in this session and send the final answer now.",
    "For lookup-style requests, your next reply must do exactly one of these:",
    "1. Provide the actual result.",
    "2. Clearly explain why the result cannot be obtained right now.",
    "Do not send another placeholder such as 'I'll check', 'let me confirm', or a vague non-answer like 'not sure'.",
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

  if (shouldRepairIncompleteReply(userText, repairedResult.text)) {
    throw new ProviderIncompleteReplyError(repairedResult.text);
  }

  return {
    result: repairedResult,
    repaired: true,
  };
}

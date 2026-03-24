import type { SandboxMode } from "./types.js";
import { sandboxModes } from "./types.js";
import { buildResumeRules, buildSystemPrompt } from "./prompt.js";

const sandboxRaw = process.env.CODEX_SANDBOX || "read-only";
const workdir = process.env.CODEX_WORKDIR || process.cwd();
const extraSystemPrompt = process.env.CODEX_SYSTEM_PROMPT;

if (!sandboxModes.includes(sandboxRaw as SandboxMode)) {
  throw new Error(
    `Invalid CODEX_SANDBOX: ${sandboxRaw}. Allowed values: ${sandboxModes.join(", ")}`,
  );
}

const sandbox = sandboxRaw as SandboxMode;

function getSystemPrompt(): string {
  return buildSystemPrompt({
    workdir,
    sandbox,
    extraPrompt: extraSystemPrompt,
  });
}

function buildOutputContract(source: string): string {
  return [
    `The current message source is: ${source}.`,
    "Reply only to the current user message.",
    "If you want to send an image back to the user, include an absolute image path or Markdown image syntax like ![desc](ABSOLUTE_PATH). Windows paths such as C:\\path\\image.png are allowed.",
    "If you want to send a non-image file back to the user, output one file per line using: FILE: ABSOLUTE_PATH.",
  ].join("\n");
}

function buildTelegramRuntimeStatusGuidance(source: string): string {
  if (source !== "telegram") {
    return "";
  }

  return [
    "Telegram runtime status guidance:",
    "- If you generate internal plans, todo_list items, or stage checklists, prefer short Chinese phrases.",
    "- Describe internal steps as user-readable stages instead of internal engineering jargon.",
    "- Keep step names concise and avoid over-splitting the work.",
    "",
  ].join("\n");
}

function buildTelegramFinalReplyGuidance(source: string): string {
  if (source !== "telegram") {
    return "";
  }

  return [
    "Telegram final reply guidance:",
    "- Write a chat-style Chinese answer for the user, not a code review report.",
    "- Start with the conclusion, then add only the minimum necessary explanation.",
    "- Prefer one short paragraph or at most three flat bullets.",
    "- Do not output local absolute paths, Markdown file links, or code reference lists.",
    "- Do not expose internal state names, class names, database names, or process-control names.",
    "- Keep user-facing commands such as /stop, but do not dump internal enums or object names.",
    "- Do not add sections like 参考代码 / 参考文件 / 对应代码位置.",
    "- Unless you actually need to send an attachment, do not mention file paths.",
    "",
  ].join("\n");
}

function buildTelegramGuidance(source: string): string {
  return `${buildTelegramRuntimeStatusGuidance(source)}${buildTelegramFinalReplyGuidance(source)}`;
}

function formatMemoryContext(memoryContext?: string): string {
  const trimmed = memoryContext?.trim();
  return trimmed ? `Memory context:\n${trimmed}\n\n` : "";
}

export function buildFirstTurnPrompt(
  userText: string,
  source: string = "web",
  memoryContext?: string,
): string {
  return `${getSystemPrompt()}

${formatMemoryContext(memoryContext)}${buildTelegramGuidance(source)}Output requirements:
${buildOutputContract(source)}

User message:
${userText}`;
}

export function buildResumePrompt(
  userText: string,
  source: string = "web",
  memoryContext?: string,
): string {
  return `${userText}

Additional requirements:
${buildResumeRules(workdir)}

${formatMemoryContext(memoryContext)}${buildTelegramGuidance(source)}Output requirements:
${buildOutputContract(source)}`;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateTitle(text: string): string {
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length > 32 ? `${clean.slice(0, 32)}...` : clean;
}

export function getWorkdir(): string {
  return workdir;
}

export function getSandbox(): SandboxMode {
  return sandbox;
}

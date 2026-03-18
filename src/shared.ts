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

export function buildFirstTurnPrompt(userText: string, source: string = "web"): string {
  return `${getSystemPrompt()}

Output requirements:
${buildOutputContract(source)}

User message:
${userText}`;
}

export function buildResumePrompt(userText: string, source: string = "web"): string {
  return `${userText}

Additional requirements:
${buildResumeRules(workdir)}

Output requirements:
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

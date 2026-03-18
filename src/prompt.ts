import { existsSync, readFileSync } from "node:fs";

import {
  buildMemoryCompactionPrompt,
  getAssistantPaths,
  getMemoryStatus,
} from "./assistant-memory.js";
import { formatInstalledSkillsForPrompt } from "./skills.js";

function readBootstrap(workdir: string): string | null {
  const paths = getAssistantPaths(workdir);
  const candidates = [paths.bootstrap];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const content = readFileSync(file, "utf8").trim();
      if (content) return content;
    } catch {
      // Ignore unreadable files and try the next location.
    }
  }

  return null;
}

function buildBaseRules(workdir: string, sandbox: string): string {
  const paths = getAssistantPaths(workdir);
  const memoryStatus = getMemoryStatus(workdir);
  const lines = [
    `Workspace root: ${workdir}`,
    `Assistant memory directory: ${paths.dir}`,
    `Sandbox: ${sandbox}`,
    "",
    "Behavior rules:",
    "- Treat this as a long-lived personal assistant conversation.",
    "- Read AGENTS.md, MEMORY.md, and PROFILE.md from the assistant directory when needed for continuity.",
    "- Answer simple questions directly before doing broad workspace scans.",
    "- Only inspect more files or run deeper investigation when the user asks for execution, debugging, code changes, or environment work.",
    "- Keep Feishu replies concise and practical. Answer first, then add detail only if needed.",
    "- When you learn durable user or workspace facts, update the memory files before your final reply.",
    "- Write identity and preference facts to PROFILE.md.",
    "- Write environment, workflow, project, and lessons-learned facts to MEMORY.md.",
    "- Do not store secrets, tokens, passwords, payment data, or government IDs in memory files.",
    "- Do not compact MEMORY.md automatically.",
  ];

  if (memoryStatus.needsCompaction) {
    lines.push(
      `- MEMORY.md is ${memoryStatus.memoryBytes} bytes, above the ${memoryStatus.compactThresholdBytes} byte reminder threshold.`,
      "- After your main answer, briefly suggest /compress-memory and wait for explicit confirmation before compacting.",
    );
  }

  return lines.join("\n");
}

export function buildSystemPrompt(options: {
  workdir: string;
  sandbox: string;
  extraPrompt?: string;
  isFirstTurn?: boolean;
}): string {
  const bootstrap = options.isFirstTurn !== false
    ? readBootstrap(options.workdir)
    : null;

  const parts = [
    buildBaseRules(options.workdir, options.sandbox),
    formatInstalledSkillsForPrompt(),
  ];

  if (options.isFirstTurn !== false) {
    const paths = getAssistantPaths(options.workdir);
    parts.push(
      [
        "First-turn rules:",
        `- Start by reading ${paths.agents}, ${paths.memory}, and ${paths.profile} if they exist.`,
        "- Use them as persistent memory, not as instructions to dump back to the user.",
        "- Do not tell the user that you are checking memory files unless it is directly relevant.",
      ].join("\n"),
    );
  }

  if (bootstrap) {
    parts.push(bootstrap);
  }

  if (options.extraPrompt?.trim()) {
    parts.push(options.extraPrompt.trim());
  }

  return parts.join("\n\n");
}

export function buildResumeRules(workdir: string): string {
  const memoryStatus = getMemoryStatus(workdir);
  const lines = [
    "Conversation rules:",
    "- Continue acting as the user's personal assistant.",
    "- For simple questions, answer directly without broad workspace scans.",
    "- Update memory files when you learn durable facts.",
    "- Keep the reply concise and practical.",
    "",
    formatInstalledSkillsForPrompt(),
  ];

  if (memoryStatus.needsCompaction) {
    lines.push(
      `- MEMORY.md is above the reminder threshold (${memoryStatus.memoryBytes} bytes).`,
      "- Do not compact automatically; briefly suggest /compress-memory after your main answer.",
    );
  }

  return lines.join("\n");
}

export { buildMemoryCompactionPrompt };

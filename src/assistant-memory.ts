import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const ASSISTANT_DIR_NAME = "codex-assistant";
export const MEMORY_COMPACT_THRESHOLD_BYTES = 12 * 1024;

function buildAgentsTemplate(workdir: string): string {
  return `# Personal Assistant Rules

You are the user's long-lived personal assistant for the workspace root \`${workdir}\`.

## Core behavior

- Act like a persistent personal assistant, not a one-shot coding bot.
- Answer simple questions directly before doing extra scanning.
- Only inspect more files or run deeper investigation when the user asks for execution, debugging, or code changes.
- Keep replies concise and practical in Feishu. Answer first, then explain only if needed.

## Memory sources

- Read \`MEMORY.md\` and \`PROFILE.md\` at the start of a new conversation.
- Treat these files as the persistent memory store for the user.
- Update memory files before the final reply when you learn durable information.

## What belongs in memory

- Stable user preferences, identity facts, naming preferences, and recurring goals.
- Durable environment facts, tool paths, project conventions, and validated lessons.
- Long-term project context that will likely matter again.

## What does not belong in memory

- Secrets, tokens, passwords, API keys, personal financial data, or government IDs.
- One-off task chatter, temporary status messages, raw logs, or disposable debugging output.
- Speculation that has not been verified.

## Update rules

- If the user explicitly says "remember this", "update my profile", or "use this from now on", write it.
- You may proactively write durable facts even without explicit instruction.
- Prefer short structured bullet updates over copying chat transcripts.
- Write user identity and preference facts to \`PROFILE.md\`.
- Write environment, project, workflow, and lessons-learned facts to \`MEMORY.md\`.
- Only edit \`AGENTS.md\` when changing durable assistant operating rules.

## Compaction

- If \`MEMORY.md\` grows too large, do not compact it automatically.
- Briefly suggest \`/compress-memory\` after your main answer and wait for the user to confirm via that command.
`;
}

function buildMemoryTemplate(workdir: string): string {
  const assistantDir = path.join(workdir, ASSISTANT_DIR_NAME);
  return `# Memory

## Environment

- Workspace root: \`${workdir}\`
- AnyBot project: \`${workdir}\`
- Assistant memory directory: \`${assistantDir}\`

## Durable Facts

- The assistant runs through AnyBot + Codex CLI + Feishu.
- Long-term memory files live in this directory.

## Preferences

- The user wants a persistent personal assistant workflow.
- Durable memory should be file-based and survive across sessions.

## Active Projects

- Improve AnyBot toward a stable personal-assistant workflow on Windows.

## Lessons

- Keep this file concise and durable.

## Captured Notes

- Add durable environment, workflow, and project facts here.
`;
}

function buildProfileTemplate(workdir: string): string {
  return `# Profile

## Assistant

- Role: personal coding and operations assistant
- Style: direct, practical, concise
- Primary environment: Windows

## User

- Main workspace root: \`${workdir}\`
- Preferred mode: persistent assistant with memory

## Long-Term Goals

- Use AnyBot + Codex CLI as a personal assistant in Feishu.

## User Facts

- Add durable identity and preference facts here.
`;
}

export interface AssistantPaths {
  dir: string;
  agents: string;
  memory: string;
  profile: string;
  bootstrap: string;
}

export interface MemoryStatus {
  assistantDir: string;
  memoryPath: string;
  profilePath: string;
  agentsPath: string;
  memoryBytes: number;
  memoryLines: number;
  needsCompaction: boolean;
  compactThresholdBytes: number;
}

function defaultWorkdir(): string {
  return process.env.CODEX_WORKDIR || process.cwd();
}

export function getAssistantPaths(workdir: string = defaultWorkdir()): AssistantPaths {
  const dir = path.join(workdir, ASSISTANT_DIR_NAME);
  return {
    dir,
    agents: path.join(dir, "AGENTS.md"),
    memory: path.join(dir, "MEMORY.md"),
    profile: path.join(dir, "PROFILE.md"),
    bootstrap: path.join(dir, "BOOTSTRAP.md"),
  };
}

export function ensureAssistantFiles(workdir: string = defaultWorkdir()): AssistantPaths {
  const paths = getAssistantPaths(workdir);
  mkdirSync(paths.dir, { recursive: true });

  if (!existsSync(paths.agents)) {
    writeFileSync(paths.agents, buildAgentsTemplate(workdir), "utf-8");
  }
  if (!existsSync(paths.memory)) {
    writeFileSync(paths.memory, buildMemoryTemplate(workdir), "utf-8");
  }
  if (!existsSync(paths.profile)) {
    writeFileSync(paths.profile, buildProfileTemplate(workdir), "utf-8");
  }

  return paths;
}

function readText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function normalizeNote(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasNormalizedNote(content: string, note: string): boolean {
  const target = normalizeNote(note);
  if (!target) return false;

  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s+/, ""))
    .some((line) => normalizeNote(line) === target);
}

function appendBulletToSection(content: string, heading: string, bullet: string): string {
  const trimmed = content.trimEnd();
  const sectionPattern = new RegExp(`(${escapeRegExp(heading)}\\r?\\n)([\\s\\S]*?)(?=\\r?\\n## |$)`);

  if (!sectionPattern.test(trimmed)) {
    const prefix = trimmed ? `${trimmed}\n\n` : "";
    return `${prefix}${heading}\n\n- ${bullet}\n`;
  }

  return trimmed.replace(sectionPattern, (_match, header: string, body: string) => {
    const nextBody = body.trimEnd();
    const prefix = nextBody ? `${nextBody}\n` : "";
    return `${header}${prefix}- ${bullet}\n`;
  }) + "\n";
}

function appendNote(filePath: string, heading: string, note: string): { changed: boolean; message: string } {
  const clean = note.trim();
  if (!clean) {
    return { changed: false, message: "Nothing to save." };
  }

  const content = readText(filePath);
  if (hasNormalizedNote(content, clean)) {
    return { changed: false, message: "That memory is already captured." };
  }

  const next = appendBulletToSection(content, heading, clean);
  writeFileSync(filePath, next, "utf-8");
  return { changed: true, message: "Saved." };
}

export function appendMemoryNote(
  note: string,
  workdir: string = defaultWorkdir(),
): { changed: boolean; message: string } {
  const paths = ensureAssistantFiles(workdir);
  return appendNote(paths.memory, "## Captured Notes", note);
}

export function appendProfileNote(
  note: string,
  workdir: string = defaultWorkdir(),
): { changed: boolean; message: string } {
  const paths = ensureAssistantFiles(workdir);
  return appendNote(paths.profile, "## User Facts", note);
}

export function getMemoryStatus(workdir: string = defaultWorkdir()): MemoryStatus {
  const paths = ensureAssistantFiles(workdir);
  const memoryText = readText(paths.memory);
  const memoryBytes = existsSync(paths.memory) ? statSync(paths.memory).size : 0;

  return {
    assistantDir: paths.dir,
    memoryPath: paths.memory,
    profilePath: paths.profile,
    agentsPath: paths.agents,
    memoryBytes,
    memoryLines: countLines(memoryText),
    needsCompaction: memoryBytes >= MEMORY_COMPACT_THRESHOLD_BYTES,
    compactThresholdBytes: MEMORY_COMPACT_THRESHOLD_BYTES,
  };
}

export function formatMemoryStatus(status: MemoryStatus): string {
  const lines = [
    "Memory status:",
    `- Directory: ${status.assistantDir}`,
    `- MEMORY.md: ${status.memoryBytes} bytes, ${status.memoryLines} lines`,
    `- Threshold: ${status.compactThresholdBytes} bytes`,
  ];

  if (status.needsCompaction) {
    lines.push("- Compaction: recommended", "", "Run /compress-memory to compact MEMORY.md.");
  } else {
    lines.push("- Compaction: not needed");
  }

  return lines.join("\n");
}

export function buildMemoryCompactionPrompt(status: MemoryStatus): string {
  return [
    "You are compacting the personal assistant memory file.",
    `Target file: ${status.memoryPath}`,
    `Current size: ${status.memoryBytes} bytes`,
    "",
    "Edit MEMORY.md in place.",
    "Requirements:",
    "- Keep the file structured markdown with short bullet lists.",
    "- Preserve stable facts, environment setup, active long-term goals, durable preferences, and validated lessons.",
    "- Remove repetition, stale status notes, temporary chatter, and one-off task noise.",
    "- Keep the Captured Notes section concise and deduplicated.",
    "- Do not modify PROFILE.md or AGENTS.md.",
    "- Do not add secrets.",
    "",
    "After editing the file, reply with a short summary of what you kept and what you removed.",
  ].join("\n");
}

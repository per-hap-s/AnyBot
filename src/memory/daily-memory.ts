import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { getDailyMemoryPath } from "./paths.js";
import type { ExtractedFact, MemoryScope } from "./types.js";

function formatTimePart(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function ensureFileHeader(filePath: string, date: Date): void {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, `# Daily Memory\n\n## ${date.toISOString().slice(0, 10)}\n`, "utf-8");
}

function buildEntryLine(scope: MemoryScope, fact: ExtractedFact, timestamp: Date): string {
  const sourceRef = fact.sourceRef ? `[source:${fact.sourceRef}]` : "";
  return `- [${formatTimePart(timestamp)}][scope:${scope}][confidence:${fact.confidence.toFixed(2)}][type:${fact.durability}]${sourceRef} ${fact.text}\n`;
}

function appendUniqueLine(filePath: string, line: string): void {
  const existing = readFileSync(filePath, "utf-8");
  if (existing.includes(line.trim())) {
    return;
  }

  appendFileSync(filePath, line, "utf-8");
}

export function appendDailyMemoryFact(
  workdir: string,
  scope: MemoryScope,
  fact: ExtractedFact,
  timestamp: Date = new Date(),
): void {
  const filePath = getDailyMemoryPath(workdir, timestamp);
  ensureFileHeader(filePath, timestamp);

  const line = buildEntryLine(scope, fact, timestamp);
  appendUniqueLine(filePath, line);
}

export function appendDailyMemoryInvalidation(
  workdir: string,
  scope: MemoryScope,
  text: string,
  timestamp: Date = new Date(),
): void {
  const filePath = getDailyMemoryPath(workdir, timestamp);
  ensureFileHeader(filePath, timestamp);
  const line = `- [${formatTimePart(timestamp)}][scope:${scope}][type:invalidation] 用户要求忘记：${text}\n`;
  appendUniqueLine(filePath, line);
}

import { mkdirSync } from "node:fs";
import path from "node:path";

import { getAssistantPaths } from "../assistant-memory.js";

function formatDatePart(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getDailyMemoryDir(workdir: string): string {
  return path.join(getAssistantPaths(workdir).dir, "memory");
}

export function ensureDailyMemoryDir(workdir: string): string {
  const dir = getDailyMemoryDir(workdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDailyMemoryPath(workdir: string, date: Date = new Date()): string {
  return path.join(ensureDailyMemoryDir(workdir), `${formatDatePart(date)}.md`);
}

import { createHash } from "node:crypto";

import { logger } from "../logger.js";
import { enqueueMemoryJob } from "./store.js";

export const MEMORY_JOB_KIND = "extract_memory";
export const MEMORY_EMBED_JOB_KIND = "embed_memory_entry";
export const MEMORY_CANONICAL_EMBED_JOB_KIND = "embed_canonical_memory";
export const MEMORY_INVALIDATION_JOB_KIND = "invalidate_memory";
export const MEMORY_PROMOTION_JOB_KIND = "promote_memory_scope";

function hashMemoryJobKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function shouldScheduleMemoryInvalidation(userText: string): boolean {
  const trimmed = userText.trim();
  if (!trimmed) return false;

  const patterns = [
    /删除.*记忆/,
    /删掉.*记忆/,
    /忘记这条记忆/,
    /忘掉这条记忆/,
    /忘记/,
    /忘掉/,
    /不要再记住/,
    /去掉.*记忆/,
    /\bforget\b/i,
    /\bdelete\b/i,
    /\bremove\b/i,
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

export function shouldScheduleMemoryExtraction(userText: string): boolean {
  const trimmed = userText.trim();
  if (!trimmed) return false;
  if (shouldScheduleMemoryInvalidation(trimmed)) {
    return false;
  }

  const patterns = [
    /^记住[:：]/,
    /以后回答时/,
    /默认/,
    /先.+再.+/,
    /不要/,
    /少用/,
    /记住/,
    /以后/,
    /偏好/,
    /习惯/,
    /我叫/,
    /我是/,
    /希望你/,
    /尽量/,
    /从现在开始/,
    /\bremember\b/i,
    /\bdefault\b/i,
    /\bavoid\b/i,
    /\buse\b/i,
    /\bprefer\b/i,
    /\bmy name is\b/i,
    /\bcall me\b/i,
    /\bfrom now on\b/i,
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

export function enqueueAutomaticMemoryJobs(input: {
  source: string;
  chatId: string;
  userText: string;
  assistantText: string;
}): void {
  if (shouldScheduleMemoryExtraction(input.userText)) {
    const extractCreated = enqueueMemoryJob(
      MEMORY_JOB_KIND,
      hashMemoryJobKey([
        input.source,
        input.chatId,
        input.userText,
        input.assistantText,
      ]),
      input,
    );
    if (extractCreated) {
      logger.info("memory.job.enqueued", {
        kind: MEMORY_JOB_KIND,
        source: input.source,
        chatId: input.chatId,
      });
    }
  }

  if (shouldScheduleMemoryInvalidation(input.userText)) {
    const invalidateCreated = enqueueMemoryJob(
      MEMORY_INVALIDATION_JOB_KIND,
      hashMemoryJobKey([
        "invalidate",
        input.source,
        input.chatId,
        input.userText,
        input.assistantText,
      ]),
      input,
    );
    if (invalidateCreated) {
      logger.info("memory.job.enqueued", {
        kind: MEMORY_INVALIDATION_JOB_KIND,
        source: input.source,
        chatId: input.chatId,
      });
    }
  }
}

export function enqueuePromotionJob(scope: string, revision: string): boolean {
  const created = enqueueMemoryJob(
    MEMORY_PROMOTION_JOB_KIND,
    `promote:${scope}:${revision}`,
    { scope },
  );
  if (created) {
    logger.info("memory.job.enqueued", {
      kind: MEMORY_PROMOTION_JOB_KIND,
      scope,
    });
  }
  return created;
}

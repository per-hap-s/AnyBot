import { createHash } from "node:crypto";

import * as db from "../web/db.js";
import { generateId } from "../shared.js";
import type {
  CanonicalMemoryCandidate,
  EmbeddingStatus,
  ExtractedFact,
  MemoryJobKind,
  MemoryScope,
} from "./types.js";

function hashText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export function buildPrivateMemoryScope(chatId: string): MemoryScope {
  return `private:${chatId}`;
}

export function saveExtractedFact(
  scope: MemoryScope,
  fact: ExtractedFact,
): { id: string; inserted: boolean } {
  const now = Date.now();
  const textHash = hashText(fact.text);
  const existing = db.getMemoryEntryByScopeHash(scope, textHash);
  const id = existing?.id || generateId();
  db.upsertMemoryEntry({
    id,
    scope,
    sourceType: fact.sourceType,
    sourceRef: fact.sourceRef || null,
    text: fact.text.trim(),
    textHash,
    confidence: fact.confidence,
    durability: fact.durability,
    status: "active",
    embeddingStatus: existing?.embeddingStatus || "pending",
    embeddingModel: existing?.embeddingModel || null,
    embeddingJson: existing?.embeddingJson || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastConfirmedAt: fact.lastConfirmedAt || now,
  });
  return { id, inserted: !existing };
}

export function markMemoryEntryEmbedding(
  id: string,
  status: EmbeddingStatus,
  embeddingModel: string | null,
  embeddingJson: string | null,
): void {
  const target = db.getMemoryEntryById(id);
  if (!target) return;

  db.upsertMemoryEntry({
    ...target,
    embeddingStatus: status,
    embeddingModel,
    embeddingJson,
    updatedAt: Date.now(),
  });
}

export function enqueueMemoryJob(
  kind: MemoryJobKind,
  dedupeKey: string,
  payload: Record<string, unknown>,
  runAfter: number = Date.now(),
): boolean {
  const now = Date.now();
  return db.enqueueMemoryJob({
    id: generateId(),
    kind,
    dedupeKey,
    payloadJson: JSON.stringify(payload),
    status: "pending",
    attempts: 0,
    lastError: null,
    runAfter,
    createdAt: now,
    updatedAt: now,
  });
}

export function listDueMemoryJobs(limit: number): db.MemoryJob[] {
  return db.listDueMemoryJobs(Date.now(), limit);
}

export function tryMarkMemoryJobRunning(job: db.MemoryJob): boolean {
  return db.claimMemoryJobRunning({
    id: job.id,
    attempts: job.attempts + 1,
    updatedAt: Date.now(),
  });
}

export function markMemoryJobCompleted(job: db.MemoryJob): void {
  db.updateMemoryJobStatus({
    id: job.id,
    status: "completed",
    attempts: job.attempts + 1,
    lastError: null,
    runAfter: job.runAfter,
    updatedAt: Date.now(),
  });
}

export function markMemoryJobFailed(
  job: db.MemoryJob,
  error: unknown,
  nextRunAfter: number,
  status: db.MemoryJob["status"] = "pending",
): void {
  db.updateMemoryJobStatus({
    id: job.id,
    status,
    attempts: job.attempts + 1,
    lastError: error instanceof Error ? error.message : String(error),
    runAfter: nextRunAfter,
    updatedAt: Date.now(),
  });
}

export function listMemoryEntriesByScope(scope: MemoryScope): db.MemoryEntry[] {
  return db.listMemoryEntriesByScope(scope).filter((entry) => entry.status === "active");
}

export function listActiveMemoryEntries(): db.MemoryEntry[] {
  return db.listActiveMemoryEntries();
}

export function listCanonicalMemoriesByScope(scope: MemoryScope): db.CanonicalMemory[] {
  return db.listCanonicalMemoriesByScope(scope);
}

export function listActiveCanonicalMemoriesByScope(scope: MemoryScope): db.CanonicalMemory[] {
  return db.listCanonicalMemoriesByScope(scope).filter((entry) => entry.status === "active");
}

export function getCanonicalMemoryById(id: string): db.CanonicalMemory | null {
  return db.getCanonicalMemoryById(id);
}

export function invalidateMemoryEntries(
  ids: string[],
  status: db.MemoryEntry["status"] = "rejected",
): number {
  const now = Date.now();
  let changed = 0;

  for (const id of ids) {
    const target = db.getMemoryEntryById(id);
    if (!target || target.status === status) {
      continue;
    }

    db.updateMemoryEntryStatus({
      id,
      status,
      updatedAt: now,
      lastConfirmedAt: target.lastConfirmedAt,
    });
    changed += 1;
  }

  return changed;
}

export function recoverRunningMemoryJobs(): number {
  return db.resetRunningMemoryJobs(Date.now());
}

export function markCanonicalMemoryEmbedding(
  id: string,
  status: EmbeddingStatus,
  embeddingModel: string | null,
  embeddingJson: string | null,
): void {
  const target = db.getCanonicalMemoryById(id);
  if (!target) return;

  db.updateCanonicalMemoryEmbedding({
    id,
    embeddingStatus: status,
    embeddingModel,
    embeddingJson,
    updatedAt: Date.now(),
  });
}

export function syncCanonicalMemories(
  scope: MemoryScope,
  candidates: CanonicalMemoryCandidate[],
  sourceEntries: Array<{ id: string; text: string; status: string }>,
): {
  activeCount: number;
  upsertedCount: number;
  supersededCount: number;
} {
  const now = Date.now();
  const existing = db.listCanonicalMemoriesByScope(scope);
  const existingByHash = new Map(existing.map((item) => [item.textHash, item]));
  const nextHashes = new Set<string>();
  let upsertedCount = 0;

  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (!text) continue;

    const textHash = hashText(text);
    nextHashes.add(textHash);
    const current = existingByHash.get(textHash);
    const sourceJson = JSON.stringify({
      sourceEntryIds: sourceEntries.map((entry) => entry.id),
      sourceTexts: sourceEntries.map((entry) => entry.text),
    });

    db.upsertCanonicalMemory({
      id: current?.id || generateId(),
      scope,
      text,
      textHash,
      confidence: candidate.confidence,
      status: "active",
      embeddingStatus: current?.embeddingStatus || "pending",
      embeddingModel: current?.embeddingModel || null,
      embeddingJson: current?.embeddingJson || null,
      sourceJson,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      lastPromotedAt: now,
    });
    upsertedCount += 1;
  }

  let supersededCount = 0;
  for (const current of existing) {
    if (current.status !== "active") {
      continue;
    }
    if (nextHashes.has(current.textHash)) {
      continue;
    }

    db.updateCanonicalMemoryStatus({
      id: current.id,
      status: "superseded",
      updatedAt: now,
      lastPromotedAt: now,
    });
    supersededCount += 1;
  }

  return {
    activeCount: candidates.length,
    upsertedCount,
    supersededCount,
  };
}

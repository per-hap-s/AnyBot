import { createEmbedding } from "./embedding.js";
import { listActiveCanonicalMemoriesByScope } from "./store.js";
import type { CanonicalMemoryRetrievalHit, MemoryScope } from "./types.js";

const DEFAULT_RETRIEVAL_TOP_K = 5;
const DEFAULT_RETRIEVAL_MIN_SCORE = 0.35;
const MEMORY_QUESTION_EXPANDED_LIMIT = 24;

function parseEmbedding(json: string | null): number[] | null {
  if (!json) {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    if (!parsed.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return -1;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return -1;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function isMemoryQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const patterns = [
    /记忆/,
    /记住/,
    /你.*知道我/,
    /你.*了解我/,
    /关于我/,
    /我的偏好/,
    /我的资料/,
    /\bmemory\b/i,
    /\bprofile\b/i,
    /\bwhat do you remember\b/i,
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

export async function retrieveRelevantCanonicalMemories(
  scope: MemoryScope,
  queryText: string,
  options?: {
    topK?: number;
    minScore?: number;
  },
): Promise<CanonicalMemoryRetrievalHit[]> {
  const canonicalEntries = listActiveCanonicalMemoriesByScope(scope);
  if (canonicalEntries.length === 0) {
    return [];
  }

  if (isMemoryQuestion(queryText)) {
    return canonicalEntries
      .slice(0, MEMORY_QUESTION_EXPANDED_LIMIT)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        confidence: entry.confidence,
        score: 1,
        updatedAt: entry.updatedAt,
      }));
  }

  const candidates = canonicalEntries
    .map((entry) => ({
      entry,
      embedding: parseEmbedding(entry.embeddingJson),
    }))
    .filter((item) => item.entry.embeddingStatus === "ready" && item.embedding !== null);

  if (candidates.length === 0) {
    return [];
  }

  const queryEmbedding = await createEmbedding(queryText);
  const topK = options?.topK ?? DEFAULT_RETRIEVAL_TOP_K;
  const minScore = options?.minScore ?? DEFAULT_RETRIEVAL_MIN_SCORE;

  return candidates
    .map(({ entry, embedding }) => ({
      id: entry.id,
      text: entry.text,
      confidence: entry.confidence,
      score: cosineSimilarity(queryEmbedding.embedding, embedding!),
      updatedAt: entry.updatedAt,
    }))
    .filter((hit) => hit.score >= minScore)
    .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt)
    .slice(0, topK);
}

import { logger } from "../logger.js";
import { analyzeQueryCategories, compareMemoryCategory } from "./category.js";
import { createEmbedding } from "./embedding.js";
import { rerankDocuments } from "./rerank.js";
import { listActiveCanonicalMemoriesByScope } from "./store.js";
import type {
  CanonicalMemoryRetrievalHit,
  MemoryScope,
  RetrievalDiagnostics,
} from "./types.js";

const DEFAULT_RETRIEVAL_TOP_K = 5;
const DEFAULT_RETRIEVAL_MIN_SCORE = 0.24;
const MEMORY_QUESTION_EXPANDED_LIMIT = 24;
const MEMORY_QUESTION_PER_CATEGORY_LIMIT = 4;
const RECENCY_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;
const GLOBAL_CANDIDATE_LIMIT = 8;
const PRIMARY_TOP_UP_LIMIT = 4;
const SECONDARY_TOP_UP_LIMIT = 2;
const PRE_RERANK_LIMIT = 12;
const SAFEGUARD_DELTA = 0.05;

type ScoredHit = CanonicalMemoryRetrievalHit & { coarseScore: number };

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

function normalizeTextForSearch(text: string): string {
  return text.trim().toLowerCase();
}

function buildSearchTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const normalized = normalizeTextForSearch(text);

  for (const match of normalized.matchAll(/[a-z0-9_.-]{2,}/g)) {
    terms.add(match[0]!);
  }

  for (const chunk of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const value = chunk[0]!;
    for (let index = 0; index < value.length - 1; index += 1) {
      terms.add(value.slice(index, index + 2));
    }
    if (value.length <= 4) {
      terms.add(value);
    }
  }

  return terms;
}

function keywordOverlapScore(queryText: string, candidateText: string): number {
  const queryTerms = buildSearchTerms(queryText);
  if (queryTerms.size === 0) {
    return 0;
  }

  const candidateTerms = buildSearchTerms(candidateText);
  if (candidateTerms.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) {
      matches += 1;
    }
  }

  const normalizedQuery = normalizeTextForSearch(queryText);
  const substringBoost = normalizeTextForSearch(candidateText).includes(normalizedQuery) ? 1 : 0;

  return Math.min(1, matches / queryTerms.size + substringBoost * 0.35);
}

function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  return Math.max(0, 1 - age / RECENCY_WINDOW_MS);
}

function normalizeMemoryText(text: string): string {
  return normalizeTextForSearch(text)
    .replace(/[。！？?!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeHits(hits: CanonicalMemoryRetrievalHit[]): CanonicalMemoryRetrievalHit[] {
  const seen = new Set<string>();
  const deduped: CanonicalMemoryRetrievalHit[] = [];
  for (const hit of hits) {
    const key = normalizeMemoryText(hit.text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hit);
  }
  return deduped;
}

function dedupeScoredHits(hits: ScoredHit[]): ScoredHit[] {
  const seen = new Set<string>();
  const deduped: ScoredHit[] = [];
  for (const hit of hits) {
    const key = normalizeMemoryText(hit.text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hit);
  }
  return deduped;
}

function buildCandidatePool(
  scoredHits: ScoredHit[],
  primaryCategory: ScoredHit["category"] | null,
  secondaryCategory: ScoredHit["category"] | null,
): ScoredHit[] {
  const merged = [
    ...scoredHits.slice(0, GLOBAL_CANDIDATE_LIMIT),
    ...(primaryCategory
      ? scoredHits.filter((hit) => hit.category === primaryCategory).slice(0, PRIMARY_TOP_UP_LIMIT)
      : []),
    ...(secondaryCategory
      ? scoredHits.filter((hit) => hit.category === secondaryCategory).slice(0, SECONDARY_TOP_UP_LIMIT)
      : []),
  ];

  return dedupeScoredHits(merged).slice(0, PRE_RERANK_LIMIT);
}

function applyPrimarySafeguard(
  hits: ScoredHit[],
  primaryCategory: ScoredHit["category"] | null,
  topK: number,
): { hits: ScoredHit[]; applied: boolean } {
  if (!primaryCategory || hits.length <= topK) {
    return { hits: hits.slice(0, topK), applied: false };
  }

  const topHits = hits.slice(0, topK);
  if (topHits.some((hit) => hit.category === primaryCategory)) {
    return { hits: topHits, applied: false };
  }

  const primaryHit = hits.find((hit) => hit.category === primaryCategory);
  const cutoff = topHits[topHits.length - 1]?.score ?? 0;
  if (!primaryHit || primaryHit.score < cutoff - SAFEGUARD_DELTA) {
    return { hits: topHits, applied: false };
  }

  return {
    hits: [...topHits.slice(0, Math.max(0, topK - 1)), primaryHit]
      .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt),
    applied: true,
  };
}

function buildDiagnostics(
  analysis: ReturnType<typeof analyzeQueryCategories>,
  embeddingAvailable: boolean,
  preliminaryHits: ScoredHit[],
  rerankCandidates: ScoredHit[],
  finalHits: ScoredHit[],
  options?: {
    rerankUsed?: boolean;
    rerankFailed?: boolean;
    safeguardApplied?: boolean;
  },
): RetrievalDiagnostics {
  return {
    queryCategories: analysis,
    embeddingAvailable,
    preliminaryHitCount: preliminaryHits.length,
    rerankCandidateCount: rerankCandidates.length,
    rerankUsed: Boolean(options?.rerankUsed),
    rerankFailed: Boolean(options?.rerankFailed),
    safeguardApplied: Boolean(options?.safeguardApplied),
    coarseTopHits: preliminaryHits.slice(0, 5).map((hit) => ({
      id: hit.id,
      category: hit.category,
      score: Number(hit.coarseScore.toFixed(4)),
    })),
    finalTopHits: finalHits.slice(0, 5).map((hit) => ({
      id: hit.id,
      category: hit.category,
      score: Number(hit.score.toFixed(4)),
    })),
  };
}

export function isMemoryQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const patterns = [
    /\u8bb0\u5fc6/,
    /\u8bb0\u4f4f/,
    /\u4f60.*\u77e5\u9053\u6211/,
    /\u4f60.*\u4e86\u89e3\u6211/,
    /\u5173\u4e8e\u6211/,
    /\u6211\u7684\u504f\u597d/,
    /\u6211\u7684\u8d44\u6599/,
    /\bmemory\b/i,
    /\bprofile\b/i,
    /\bwhat do you remember\b/i,
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

export async function retrieveRelevantCanonicalMemoriesDetailed(
  scope: MemoryScope,
  queryText: string,
  options?: {
    topK?: number;
    minScore?: number;
  },
): Promise<{ hits: CanonicalMemoryRetrievalHit[]; diagnostics: RetrievalDiagnostics }> {
  const canonicalEntries = listActiveCanonicalMemoriesByScope(scope);
  const analysis = analyzeQueryCategories(queryText);
  if (canonicalEntries.length === 0) {
    return {
      hits: [],
      diagnostics: buildDiagnostics(analysis, false, [], [], []),
    };
  }

  if (isMemoryQuestion(queryText)) {
    const limitedByCategory = new Map<string, number>();
    const groupedHits = dedupeHits(
      canonicalEntries
        .slice()
        .sort((left, right) =>
          compareMemoryCategory(left.category, right.category)
          || right.confidence - left.confidence
          || right.updatedAt - left.updatedAt)
        .filter((entry) => {
          const count = limitedByCategory.get(entry.category) || 0;
          if (count >= MEMORY_QUESTION_PER_CATEGORY_LIMIT) {
            return false;
          }
          limitedByCategory.set(entry.category, count + 1);
          return true;
        })
        .slice(0, MEMORY_QUESTION_EXPANDED_LIMIT)
        .map((entry) => ({
          id: entry.id,
          text: entry.text,
          category: entry.category,
          confidence: entry.confidence,
          score: 1,
          updatedAt: entry.updatedAt,
        })),
    );

    return {
      hits: groupedHits,
      diagnostics: buildDiagnostics(
        analysis,
        false,
        groupedHits.map((hit) => ({ ...hit, coarseScore: hit.score })),
        groupedHits.map((hit) => ({ ...hit, coarseScore: hit.score })),
        groupedHits.map((hit) => ({ ...hit, coarseScore: hit.score })),
      ),
    };
  }

  let queryEmbedding: Awaited<ReturnType<typeof createEmbedding>> | null = null;
  try {
    queryEmbedding = await createEmbedding(queryText);
  } catch (error) {
    logger.warn("memory.retrieve.embedding_unavailable", {
      scope,
      queryChars: queryText.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const now = Date.now();
  const topK = options?.topK ?? DEFAULT_RETRIEVAL_TOP_K;
  const minScore = options?.minScore ?? DEFAULT_RETRIEVAL_MIN_SCORE;

  const scoredHits = canonicalEntries
    .map((entry) => {
      const embedding = parseEmbedding(entry.embeddingJson);
      const vectorScore = queryEmbedding && embedding && entry.embeddingStatus === "ready"
        ? Math.max(0, cosineSimilarity(queryEmbedding.embedding, embedding))
        : 0;
      const lexicalScore = keywordOverlapScore(queryText, entry.text);
      const categoryPrior = analysis.primary === entry.category
        ? 1
        : analysis.secondary === entry.category
          ? 0.6
          : 0;
      const freshnessScore = recencyScore(entry.updatedAt, now);
      const confidenceScore = Math.max(0, Math.min(1, entry.confidence));
      const coarseScore = vectorScore * 0.4
        + lexicalScore * 0.2
        + categoryPrior * 0.15
        + confidenceScore * 0.15
        + freshnessScore * 0.1;

      return {
        id: entry.id,
        text: entry.text,
        category: entry.category,
        confidence: entry.confidence,
        score: coarseScore,
        coarseScore,
        updatedAt: entry.updatedAt,
      } satisfies ScoredHit;
    })
    .sort((left, right) => right.coarseScore - left.coarseScore || right.updatedAt - left.updatedAt);

  const preliminaryHits = scoredHits.filter((hit) => hit.coarseScore >= minScore);
  if (preliminaryHits.length === 0) {
    return {
      hits: [],
      diagnostics: buildDiagnostics(analysis, Boolean(queryEmbedding), [], [], []),
    };
  }

  const rerankCandidates = buildCandidatePool(
    preliminaryHits,
    analysis.primary,
    analysis.secondary,
  );

  let finalCandidates = rerankCandidates.map((hit) => ({ ...hit }));
  let rerankUsed = false;
  let rerankFailed = false;

  if (rerankCandidates.length > 0) {
    try {
      const reranked = await rerankDocuments(
        queryText,
        rerankCandidates.map((item) => item.text),
        { topN: rerankCandidates.length },
      );
      const rerankScores = new Map<number, number>(
        reranked.results.map((item) => [item.index, item.score]),
      );
      finalCandidates = rerankCandidates.map((hit, index) => {
        const rerankScore = rerankScores.get(index) ?? 0;
        return {
          ...hit,
          score: hit.coarseScore * 0.25 + rerankScore * 0.75,
        };
      });
      rerankUsed = true;
    } catch (error) {
      rerankFailed = true;
      logger.warn("memory.rerank.failed", {
        scope,
        queryChars: queryText.length,
        candidateCount: rerankCandidates.length,
        error: error instanceof Error ? error.message : String(error),
      });
      finalCandidates = rerankCandidates.map((hit) => ({ ...hit, score: hit.coarseScore }));
    }
  }

  const safeguarded = applyPrimarySafeguard(
    dedupeScoredHits(
      finalCandidates.sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt),
    ),
    analysis.primary,
    topK,
  );

  const finalHits = safeguarded.hits.map((hit) => ({
    id: hit.id,
    text: hit.text,
    category: hit.category,
    confidence: hit.confidence,
    score: hit.score,
    updatedAt: hit.updatedAt,
  }));

  return {
    hits: finalHits,
    diagnostics: buildDiagnostics(
      analysis,
      Boolean(queryEmbedding),
      preliminaryHits,
      rerankCandidates,
      safeguarded.hits,
      {
        rerankUsed,
        rerankFailed,
        safeguardApplied: safeguarded.applied,
      },
    ),
  };
}

export async function retrieveRelevantCanonicalMemories(
  scope: MemoryScope,
  queryText: string,
  options?: {
    topK?: number;
    minScore?: number;
  },
): Promise<CanonicalMemoryRetrievalHit[]> {
  const result = await retrieveRelevantCanonicalMemoriesDetailed(scope, queryText, options);
  return result.hits;
}

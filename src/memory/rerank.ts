import { logger } from "../logger.js";

const DEFAULT_RERANK_MODEL = process.env.SILICONFLOW_RERANK_MODEL?.trim() || "BAAI/bge-reranker-v2-m3";
const DEFAULT_RERANK_ENDPOINT = process.env.SILICONFLOW_RERANK_URL?.trim() || "https://api.siliconflow.cn/v1/rerank";
const DEFAULT_RERANK_TIMEOUT_MS = Number.parseInt(
  process.env.SILICONFLOW_RERANK_TIMEOUT_MS?.trim() || "20000",
  10,
);

type RerankApiResponse = {
  model?: string;
  results?: Array<{
    index?: number;
    relevance_score?: number;
  }>;
};

function getRerankApiKey(): string {
  const key = process.env.SILICONFLOW_API_KEY?.trim();
  if (!key) {
    throw new Error("SILICONFLOW_API_KEY is not configured");
  }
  return key;
}

export async function rerankDocuments(
  query: string,
  documents: string[],
  options?: {
    topN?: number;
  },
): Promise<{
  model: string;
  results: Array<{ index: number; score: number }>;
}> {
  const trimmedQuery = query.trim();
  const normalizedDocs = documents.map((item) => item.trim()).filter(Boolean);

  if (!trimmedQuery) {
    throw new Error("Cannot rerank with an empty query");
  }
  if (normalizedDocs.length === 0) {
    return {
      model: DEFAULT_RERANK_MODEL,
      results: [],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_RERANK_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(DEFAULT_RERANK_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getRerankApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_RERANK_MODEL,
        query: trimmedQuery,
        documents: normalizedDocs,
        top_n: Math.min(options?.topN ?? normalizedDocs.length, normalizedDocs.length),
        return_documents: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Rerank request timed out after ${DEFAULT_RERANK_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Rerank request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const parsed = await response.json() as RerankApiResponse;
  let invalidCount = 0;
  let duplicateCount = 0;
  let outOfRangeCount = 0;
  const seen = new Set<number>();
  const results: Array<{ index: number; score: number }> = [];

  for (const item of parsed.results || []) {
    if (!Number.isInteger(item.index) || typeof item.relevance_score !== "number" || !Number.isFinite(item.relevance_score)) {
      invalidCount += 1;
      continue;
    }

    const index = item.index as number;
    if (index < 0 || index >= normalizedDocs.length) {
      outOfRangeCount += 1;
      continue;
    }
    if (seen.has(index)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(index);
    results.push({
      index,
      score: item.relevance_score as number,
    });
  }

  if (invalidCount > 0 || duplicateCount > 0 || outOfRangeCount > 0) {
    logger.warn("memory.rerank.malformed_response", {
      model: parsed.model || DEFAULT_RERANK_MODEL,
      documentCount: normalizedDocs.length,
      resultCount: parsed.results?.length || 0,
      acceptedCount: results.length,
      invalidCount,
      duplicateCount,
      outOfRangeCount,
    });
  }

  return {
    model: parsed.model || DEFAULT_RERANK_MODEL,
    results,
  };
}

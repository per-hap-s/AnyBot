const DEFAULT_EMBEDDING_MODEL = process.env.SILICONFLOW_EMBEDDING_MODEL?.trim() || "BAAI/bge-m3";
const DEFAULT_EMBEDDING_ENDPOINT = process.env.SILICONFLOW_EMBEDDING_URL?.trim() || "https://api.siliconflow.cn/v1/embeddings";
const DEFAULT_EMBEDDING_TIMEOUT_MS = Number.parseInt(
  process.env.SILICONFLOW_EMBEDDING_TIMEOUT_MS?.trim() || "20000",
  10,
);

type EmbeddingApiResponse = {
  model?: string;
  data?: Array<{
    embedding?: number[];
  }>;
};

function getEmbeddingApiKey(): string {
  const key = process.env.SILICONFLOW_API_KEY?.trim();
  if (!key) {
    throw new Error("SILICONFLOW_API_KEY is not configured");
  }
  return key;
}

export async function createEmbedding(text: string): Promise<{
  model: string;
  embedding: number[];
}> {
  const input = text.trim();
  if (!input) {
    throw new Error("Cannot create embedding for empty text");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_EMBEDDING_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(DEFAULT_EMBEDDING_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getEmbeddingApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_EMBEDDING_MODEL,
        input: [input],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Embedding request timed out after ${DEFAULT_EMBEDDING_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const parsed = await response.json() as EmbeddingApiResponse;
  const embedding = parsed.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Embedding response did not contain a vector");
  }

  return {
    model: parsed.model || DEFAULT_EMBEDDING_MODEL,
    embedding,
  };
}

export type MemoryScope = `private:${string}`;

export type MemorySourceType = "daily_memory" | "long_term_memory";

export type MemoryDurability = "ephemeral" | "medium" | "long_term_candidate";

export type MemoryStatus = "active" | "superseded" | "rejected";

export type EmbeddingStatus = "pending" | "ready" | "failed";

export type MemoryJobKind =
  | "extract_memory"
  | "embed_memory_entry"
  | "embed_canonical_memory"
  | "invalidate_memory"
  | "promote_memory_scope";

export interface CanonicalMemoryCandidate {
  text: string;
  confidence: number;
}

export interface ExtractedFact {
  text: string;
  confidence: number;
  durability: MemoryDurability;
  sourceType: MemorySourceType;
  sourceRef?: string | null;
  lastConfirmedAt?: number | null;
}

export interface MemoryHit {
  id: string;
  text: string;
  sourceType: MemorySourceType;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryInvalidationDecision {
  targetIds: string[];
}

export interface CanonicalMemoryRetrievalHit {
  id: string;
  text: string;
  confidence: number;
  score: number;
  updatedAt: number;
}

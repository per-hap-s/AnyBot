export type MemoryScope = `private:${string}`;

export type MemorySourceType = "daily_memory" | "long_term_memory";

export type MemoryDurability = "ephemeral" | "medium" | "long_term_candidate";

export type MemoryStatus = "active" | "superseded" | "rejected";

export type EmbeddingStatus = "pending" | "ready" | "failed";

export type MemoryCategory =
  | "preference"
  | "identity"
  | "workflow"
  | "environment"
  | "project";

export type MemoryJobKind =
  | "extract_memory"
  | "embed_memory_entry"
  | "embed_canonical_memory"
  | "invalidate_memory"
  | "promote_memory_scope";

export interface CanonicalMemoryCandidate {
  text: string;
  confidence: number;
  category?: MemoryCategory;
}

export interface ExtractedFact {
  text: string;
  confidence: number;
  durability: MemoryDurability;
  category: MemoryCategory;
  sourceType: MemorySourceType;
  sourceRef?: string | null;
  lastConfirmedAt?: number | null;
}

export interface MemoryHit {
  id: string;
  text: string;
  sourceType: MemorySourceType;
  category: MemoryCategory;
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
  category: MemoryCategory;
  confidence: number;
  score: number;
  updatedAt: number;
}

export interface RetrievalDiagnostics {
  queryCategories: {
    primary: MemoryCategory | null;
    secondary: MemoryCategory | null;
    confidence: number;
    scores: Record<MemoryCategory, number>;
  };
  embeddingAvailable: boolean;
  preliminaryHitCount: number;
  rerankCandidateCount: number;
  rerankUsed: boolean;
  rerankFailed: boolean;
  safeguardApplied: boolean;
  coarseTopHits: Array<{ id: string; category: MemoryCategory; score: number }>;
  finalTopHits: Array<{ id: string; category: MemoryCategory; score: number }>;
}

import { MEMORY_CATEGORY_LABELS, MEMORY_CATEGORY_ORDER } from "./category.js";
import type { CanonicalMemoryRetrievalHit, MemoryCategory } from "./types.js";

function normalizeMemoryText(text: string): string {
  return text.trim().toLowerCase().replace(/[。！？?!]/g, "").replace(/\s+/g, " ");
}

function groupHitsByCategory(
  hits: CanonicalMemoryRetrievalHit[],
): Array<[MemoryCategory, CanonicalMemoryRetrievalHit[]]> {
  return MEMORY_CATEGORY_ORDER
    .map((category) => [
      category,
      hits
        .filter((hit) => hit.category === category)
        .sort((left, right) => right.confidence - left.confidence || right.updatedAt - left.updatedAt),
    ] as [MemoryCategory, CanonicalMemoryRetrievalHit[]])
    .filter(([, items]) => items.length > 0);
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

export function buildRelevantMemoryPromptSection(
  hits: CanonicalMemoryRetrievalHit[],
  options?: { isMemoryQuestion?: boolean },
): string {
  if (hits.length === 0) {
    if (!options?.isMemoryQuestion) {
      return "";
    }

    return [
      "Relevant memory from the structured memory store:",
      "- No active canonical memory is currently available for this user.",
      "- Do not use legacy MEMORY.md or PROFILE.md as fallback memory sources.",
    ].join("\n");
  }

  const lines = [
    "Relevant memory from the structured memory store:",
    "- This is the source of truth for remembered user facts and durable preferences.",
    "- Do not answer memory questions from legacy MEMORY.md or PROFILE.md.",
  ];

  if (options?.isMemoryQuestion) {
    for (const [category, items] of groupHitsByCategory(dedupeHits(hits))) {
      lines.push(`- ${MEMORY_CATEGORY_LABELS[category]}:`);
      for (const hit of items.slice(0, 4)) {
        lines.push(`  - ${hit.text}`);
      }
    }
    return lines.join("\n");
  }

  for (const hit of dedupeHits(hits)) {
    lines.push(`- [${MEMORY_CATEGORY_LABELS[hit.category]}] ${hit.text}`);
  }

  return lines.join("\n");
}

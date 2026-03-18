import type { CanonicalMemoryRetrievalHit } from "./types.js";

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

  for (const hit of hits) {
    lines.push(`- ${hit.text}`);
  }

  return lines.join("\n");
}

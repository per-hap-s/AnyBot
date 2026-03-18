import type { IProvider } from "../providers/types.js";
import type { MemoryEntry, CanonicalMemory } from "../web/db.js";
import type { CanonicalMemoryCandidate } from "./types.js";

const DEFAULT_PROMOTION_MODEL = process.env.MEMORY_PROMOTION_MODEL?.trim() || "gpt-5.4";

type PromotionResponse = {
  canonical_memories?: Array<{
    text?: string;
    confidence?: number;
  }>;
};

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.8;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeFactText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (/[。！？?!]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}。`;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Memory promotion did not return JSON");
  }
  return match[0];
}

function formatDailyEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return "(none)";
  }

  return entries
    .map((entry) => `- id=${entry.id}; text=${entry.text}; confidence=${entry.confidence}; durability=${entry.durability}`)
    .join("\n");
}

function formatCanonicalEntries(entries: CanonicalMemory[]): string {
  if (entries.length === 0) {
    return "(none)";
  }

  return entries
    .map((entry) => `- text=${entry.text}; confidence=${entry.confidence}; status=${entry.status}`)
    .join("\n");
}

function buildPromotionPrompt(
  dailyEntries: MemoryEntry[],
  canonicalEntries: CanonicalMemory[],
): string {
  return [
    "Promote durable private-assistant memories into a compact canonical memory set.",
    "Return JSON only. No markdown. No prose.",
    'Schema: {"canonical_memories":[{"text":"string","confidence":0.0}]}',
    "Rules:",
    "- Produce the final canonical memory set, not a diff.",
    "- Keep only stable identity facts, stable preferences, long-term goals, and durable workflow/environment facts that matter repeatedly.",
    "- Merge near-duplicates into one stronger memory line.",
    "- Prefer the more specific and more recent wording when two memories overlap.",
    "- Exclude one-off states, temporary constraints, and noise.",
    "- Keep each `text` as a short standalone fact in Chinese.",
    "- Keep the set compact. Usually 3-12 items.",
    "- If a prior canonical memory is no longer supported by the active daily memories, leave it out of the final set.",
    "",
    "Current active canonical memories:",
    formatCanonicalEntries(canonicalEntries),
    "",
    "Current active daily memories:",
    formatDailyEntries(dailyEntries),
  ].join("\n");
}

export async function promoteCanonicalMemories(
  provider: IProvider,
  options: {
    workdir: string;
    sandbox: string;
    dailyEntries: MemoryEntry[];
    canonicalEntries: CanonicalMemory[];
  },
): Promise<CanonicalMemoryCandidate[]> {
  if (options.dailyEntries.length === 0) {
    return [];
  }

  const result = await provider.run({
    workdir: options.workdir,
    sandbox: options.sandbox as never,
    model: DEFAULT_PROMOTION_MODEL,
    prompt: buildPromotionPrompt(options.dailyEntries, options.canonicalEntries),
  });

  const parsed = JSON.parse(extractJsonObject(result.text)) as PromotionResponse;
  const seen = new Set<string>();

  return (parsed.canonical_memories || [])
    .filter((item) => typeof item.text === "string" && item.text.trim())
    .map((item) => ({
      text: normalizeFactText(item.text!),
      confidence: clampConfidence(item.confidence),
    }))
    .filter((item) => {
      const key = item.text.trim().toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

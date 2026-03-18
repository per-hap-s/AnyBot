import type { IProvider } from "../providers/types.js";
import type { ExtractedFact, MemoryInvalidationDecision } from "./types.js";
import type { MemoryEntry } from "../web/db.js";

const DEFAULT_EXTRACTION_MODEL = process.env.MEMORY_EXTRACTION_MODEL?.trim() || "gpt-5.4";

type ExtractionResponse = {
  facts?: Array<{
    text?: string;
    confidence?: number;
    durability?: string;
    should_store?: boolean;
  }>;
};

function buildExtractionPrompt(userText: string, assistantText: string): string {
  return [
    "Extract durable personal-assistant memory candidates from this private chat turn.",
    "Return JSON only. No markdown. No prose.",
    "Schema:",
    '{"facts":[{"text":"string","confidence":0.0,"durability":"medium|long_term_candidate","should_store":true}]}',
    "Rules:",
    "- Keep only stable preferences, identity facts, recurring goals, durable environment facts, and validated lessons.",
    "- Treat explicit remember/default/from now on/call me/avoid/first-then statements as strong memory signals.",
    "- Exclude one-off tasks, temporary status, speculative claims, emotional reactions, and disposable chatter.",
    "- `text` must be a short standalone fact in Chinese.",
    "- Use `should_store=false` when uncertain.",
    "Examples:",
    '- "记住：以后回答时先给结论，再补解释" -> "用户偏好：回答时先给结论，再补解释。"',
    '- "记住：默认少用项目符号" -> "用户偏好：默认少用项目符号。"',
    '- "我叫LI，以后这样叫我" -> "用户希望以后被称为LI。"',
    '- "今天中午我吃了面" -> do not store',
    "",
    "User message:",
    userText,
    "",
    "Assistant reply:",
    assistantText,
  ].join("\n");
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.7;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeDurability(value: unknown): ExtractedFact["durability"] {
  return value === "long_term_candidate" ? "long_term_candidate" : "medium";
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Memory extraction did not return JSON");
  }
  return match[0];
}

function normalizeFactText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (/[。！？.!?]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}。`;
}

function heuristicExplicitFact(userText: string): ExtractedFact | null {
  const match = userText.trim().match(/^记住[:：]\s*(.+)$/);
  if (!match) return null;

  const body = match[1].trim();
  if (!body) return null;

  let text = body;
  if (/^(以后回答时|默认|先.+再.+|不要|少用|尽量)/.test(body)) {
    text = `用户偏好：${body}`;
  } else if (/^(我叫|叫我)/.test(body)) {
    text = body.replace(/^我叫/, "用户名叫");
  }

  return {
    text: normalizeFactText(text),
    confidence: 0.98,
    durability: "long_term_candidate",
    sourceType: "daily_memory",
    sourceRef: null,
    lastConfirmedAt: Date.now(),
  };
}

function buildInvalidationPrompt(userText: string, entries: MemoryEntry[]): string {
  const list = entries.length === 0
    ? "(none)"
    : entries
        .map((entry) => `- id=${entry.id}; text=${entry.text}; status=${entry.status}`)
        .join("\n");

  return [
    "Select which active memories should be invalidated based on the user's forget/delete request.",
    "Return JSON only. No markdown. No prose.",
    'Schema: {"target_ids":["string"]}',
    "Rules:",
    "- Only choose ids that the user clearly wants to forget, delete, remove, or stop using.",
    "- If nothing matches, return an empty array.",
    "- Never invent ids.",
    "",
    "User request:",
    userText,
    "",
    "Active memories:",
    list,
  ].join("\n");
}

export async function extractDurableFacts(
  provider: IProvider,
  options: {
    workdir: string;
    sandbox: string;
    userText: string;
    assistantText: string;
  },
): Promise<ExtractedFact[]> {
  const result = await provider.run({
    workdir: options.workdir,
    sandbox: options.sandbox as never,
    model: DEFAULT_EXTRACTION_MODEL,
    prompt: buildExtractionPrompt(options.userText, options.assistantText),
  });

  const parsed = JSON.parse(extractJsonObject(result.text)) as ExtractionResponse;
  const facts = parsed.facts || [];

  const normalizedFacts = facts
    .filter((fact) => fact.should_store === true && typeof fact.text === "string" && fact.text.trim())
    .map((fact) => ({
      text: normalizeFactText(fact.text!),
      confidence: clampConfidence(fact.confidence),
      durability: normalizeDurability(fact.durability),
      sourceType: "daily_memory" as const,
      sourceRef: null,
      lastConfirmedAt: Date.now(),
    }));

  if (normalizedFacts.length > 0) {
    return normalizedFacts;
  }

  const fallback = heuristicExplicitFact(options.userText);
  return fallback ? [fallback] : [];
}

export async function selectMemoriesToInvalidate(
  provider: IProvider,
  options: {
    workdir: string;
    sandbox: string;
    userText: string;
    entries: MemoryEntry[];
  },
): Promise<MemoryInvalidationDecision> {
  if (options.entries.length === 0) {
    return { targetIds: [] };
  }

  const result = await provider.run({
    workdir: options.workdir,
    sandbox: options.sandbox as never,
    model: DEFAULT_EXTRACTION_MODEL,
    prompt: buildInvalidationPrompt(options.userText, options.entries),
  });

  const parsed = JSON.parse(extractJsonObject(result.text)) as { target_ids?: string[] };
  const knownIds = new Set(options.entries.map((entry) => entry.id));
  return {
    targetIds: (parsed.target_ids || []).filter(
      (id): id is string => typeof id === "string" && knownIds.has(id),
    ),
  };
}

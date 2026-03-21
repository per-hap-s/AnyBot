import { inferMemoryCategoryFromText, isMemoryCategory } from "./category.js";
import type { IProvider } from "../providers/types.js";
import type { ExtractedFact, MemoryInvalidationDecision } from "./types.js";
import type { MemoryEntry } from "../web/db.js";

const DEFAULT_EXTRACTION_MODEL = process.env.MEMORY_EXTRACTION_MODEL?.trim() || "gpt-5.4";

type ExtractionResponse = {
  facts?: Array<{
    text?: string;
    confidence?: number;
    durability?: string;
    category?: string;
    should_store?: boolean;
  }>;
};

function buildExtractionPrompt(userText: string, assistantText: string): string {
  return [
    "Extract durable personal-assistant memory candidates from this private chat turn.",
    "Return JSON only. No markdown. No prose.",
    "Schema:",
    '{"facts":[{"text":"string","confidence":0.0,"durability":"medium|long_term_candidate","category":"preference|identity|workflow|environment|project","should_store":true}]}',
    "Rules:",
    "- Keep stable preferences, identity facts, recurring goals, durable workflow facts, durable environment facts, project facts, and validated lessons.",
    "- Because retrieval uses embeddings and canonical promotion, it is acceptable to keep moderately useful durable facts instead of only ultra-strict facts.",
    "- Treat explicit remember/default/from now on/call me/avoid/first-then statements as strong memory signals.",
    "- Exclude one-off tasks, temporary status, speculative claims, emotional reactions, and disposable chatter.",
    "- `text` must be a short standalone fact in Chinese.",
    "- `category` must be one of: preference, identity, workflow, environment, project.",
    "- Use `should_store=false` when uncertain.",
    "Examples:",
    '- "记住：以后回答时先给结论，再补充解释" -> {"text":"用户偏好：回答时先给结论，再补充解释。","category":"preference"}',
    '- "我叫LI，以后这样叫我" -> {"text":"用户希望被称为LI。","category":"identity"}',
    '- "我的任务文件都在D盘，还会附带手册" -> {"text":"用户的任务文件通常放在D盘，并常附带手册。","category":"workflow"}',
    '- "AnyBot 记忆用 bge-m3 做 embedding" -> {"text":"AnyBot 当前记忆使用 BAAI/bge-m3 进行 embedding。","category":"environment"}',
    '- "ProxyPilot 是另一个长期任务项目" -> {"text":"ProxyPilot 是用户的长期项目之一。","category":"project"}',
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
  if (/[。！？?!]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}。`;
}

function heuristicExplicitFact(userText: string): ExtractedFact | null {
  const trimmed = userText.trim();
  const match = trimmed.match(/^记住[:：]?\s*(.+)$/);
  const body = match?.[1]?.trim() || trimmed;

  const strongSignal = /记住|以后|默认|不要|尽量|少用|偏好|习惯|工作流|环境|项目|手册|任务文件|路径|目录|我叫|叫我|称呼|RAG|embedding|bge/i
    .test(trimmed);
  if (!strongSignal || !body) {
    return null;
  }

  let text = body;
  if (/^(以后|默认|不要|尽量|少用|回答时|回复时)/.test(body)) {
    text = `用户偏好：${body}`;
  } else if (/^(我叫|叫我|称呼我)/.test(body)) {
    text = body
      .replace(/^我叫/, "用户希望被称为")
      .replace(/^叫我/, "用户希望被称为")
      .replace(/^称呼我/, "用户希望被称为");
  }

  const normalizedText = normalizeFactText(text);
  return {
    text: normalizedText,
    confidence: match ? 0.98 : 0.82,
    durability: match ? "long_term_candidate" : "medium",
    category: inferMemoryCategoryFromText(normalizedText),
    sourceType: "daily_memory",
    sourceRef: null,
    lastConfirmedAt: Date.now(),
  };
}

function buildInvalidationPrompt(userText: string, entries: MemoryEntry[]): string {
  const list = entries.length === 0
    ? "(none)"
    : entries
        .map((entry) => `- id=${entry.id}; category=${entry.category}; text=${entry.text}; status=${entry.status}`)
        .join("\n");

  return [
    "Select which active memories should be invalidated based on the user's forget/delete request.",
    "Return JSON only. No markdown. No prose.",
    '{"target_ids":["string"]}',
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
    .map((fact) => {
      const text = normalizeFactText(fact.text!);
      return {
        text,
        confidence: clampConfidence(fact.confidence),
        durability: normalizeDurability(fact.durability),
        category: isMemoryCategory(fact.category)
          ? fact.category
          : inferMemoryCategoryFromText(text),
        sourceType: "daily_memory" as const,
        sourceRef: null,
        lastConfirmedAt: Date.now(),
      };
    });

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

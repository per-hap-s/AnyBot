import test from "node:test";
import assert from "node:assert/strict";

import { buildRelevantMemoryPromptSection } from "./prompt-context.js";
import type { CanonicalMemoryRetrievalHit } from "./types.js";

function createHit(
  id: string,
  text: string,
  category: CanonicalMemoryRetrievalHit["category"],
): CanonicalMemoryRetrievalHit {
  return {
    id,
    text,
    category,
    confidence: 0.9,
    score: 0.8,
    updatedAt: 1,
  };
}

test("memory-question prompt groups hits, dedupes text, and caps each category", () => {
  const prompt = buildRelevantMemoryPromptSection([
    createHit("1", "用户希望被称为LI。", "identity"),
    createHit("2", "用户希望被称为LI。", "identity"),
    createHit("3", "用户偏好回答先给结论。", "preference"),
    createHit("4", "用户偏好回答简短直接。", "preference"),
    createHit("5", "用户偏好语气自然。", "preference"),
    createHit("6", "用户偏好少说废话。", "preference"),
    createHit("7", "用户偏好每次审查完一个就汇报一次。", "preference"),
  ], {
    isMemoryQuestion: true,
  });

  assert.match(prompt, /- Identity:/);
  assert.match(prompt, /- Preference:/);
  assert.equal(prompt.split("用户希望被称为LI。").length - 1, 1);
  assert.equal(prompt.split("用户偏好").length - 1, 4);
});

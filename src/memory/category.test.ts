import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeQueryCategories,
  inferMemoryCategoryFromText,
} from "./category.js";

test("analyzeQueryCategories detects identity queries", () => {
  const result = analyzeQueryCategories("我叫LI，以后这样叫我");
  assert.equal(result.primary, "identity");
  assert.equal(inferMemoryCategoryFromText("用户希望被称为LI。"), "identity");
});

test("analyzeQueryCategories detects preference queries", () => {
  const result = analyzeQueryCategories("记住：以后回答先给结论，再补充解释");
  assert.equal(result.primary, "preference");
});

test("analyzeQueryCategories keeps technical stack in environment", () => {
  const result = analyzeQueryCategories("AnyBot 当前记忆使用 BAAI/bge-m3 embedding 和 chat.db");
  assert.equal(result.primary, "environment");
});

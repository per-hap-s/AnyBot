import test from "node:test";
import assert from "node:assert/strict";

import { buildFirstTurnPrompt, buildResumePrompt } from "./shared.js";

test("telegram prompts include runtime plan guidance", () => {
  const firstTurnPrompt = buildFirstTurnPrompt("帮我查一下 AnyBot 现在在做什么", "telegram");
  const resumePrompt = buildResumePrompt("继续", "telegram");

  assert.match(firstTurnPrompt, /Telegram runtime status guidance:/);
  assert.match(firstTurnPrompt, /prefer short Chinese phrases/i);
  assert.match(firstTurnPrompt, /Telegram final reply guidance:/);
  assert.match(firstTurnPrompt, /chat-style Chinese answer/i);
  assert.match(resumePrompt, /Telegram runtime status guidance:/);
  assert.match(resumePrompt, /user-readable stage/i);
  assert.match(resumePrompt, /Telegram final reply guidance:/);
  assert.match(resumePrompt, /do not output local absolute paths/i);
});

test("telegram first-turn prompt includes final reply guidance only once", () => {
  const firstTurnPrompt = buildFirstTurnPrompt("你看看 /stop 现在是怎么实现的，简单说", "telegram");
  const matches = firstTurnPrompt.match(/Telegram final reply guidance:/g) || [];

  assert.equal(matches.length, 1);
});

test("web prompts do not include telegram runtime plan guidance", () => {
  const firstTurnPrompt = buildFirstTurnPrompt("hello", "web");
  const resumePrompt = buildResumePrompt("continue", "web");

  assert.doesNotMatch(firstTurnPrompt, /Telegram runtime status guidance:/);
  assert.doesNotMatch(resumePrompt, /Telegram runtime status guidance:/);
  assert.doesNotMatch(firstTurnPrompt, /Telegram final reply guidance:/);
  assert.doesNotMatch(resumePrompt, /Telegram final reply guidance:/);
});

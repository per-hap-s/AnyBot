import test from "node:test";
import assert from "node:assert/strict";

import {
  ProviderIncompleteReplyError,
  buildIncompleteReplyRecoveryPrompt,
  ensureCompletedUserReply,
  isLikelyLookupTask,
  looksLikeProgressOnlyReply,
  shouldRepairIncompleteReply,
} from "./reply-completion.js";

test("isLikelyLookupTask detects common lookup-style user requests", () => {
  assert.equal(isLikelyLookupTask("What is the current weather in Tokyo?"), true);
  assert.equal(isLikelyLookupTask("帮我查一下今天东京天气"), true);
  assert.equal(isLikelyLookupTask("Reply with exactly 'I will check that.'"), false);
});

test("looksLikeProgressOnlyReply detects pure placeholder replies", () => {
  assert.equal(looksLikeProgressOnlyReply("I will check that."), true);
  assert.equal(looksLikeProgressOnlyReply("我先查一下。"), true);
  assert.equal(
    looksLikeProgressOnlyReply("Tokyo is currently about 14°C with light wind."),
    false,
  );
});

test("shouldRepairIncompleteReply only triggers for lookup requests with placeholder-only replies", () => {
  assert.equal(
    shouldRepairIncompleteReply("帮我查一下今天东京天气", "我先查一下。"),
    true,
  );
  assert.equal(
    shouldRepairIncompleteReply("Reply with exactly 'I will check that.'", "I will check that."),
    false,
  );
});

test("buildIncompleteReplyRecoveryPrompt instructs the provider to finish the same task", () => {
  const prompt = buildIncompleteReplyRecoveryPrompt(
    "帮我查一下今天东京天气",
    "我先查一下。",
  );

  assert.match(prompt, /did not answer the user/i);
  assert.match(prompt, /Original user request:/);
  assert.match(prompt, /帮我查一下今天东京天气/);
});

test("ensureCompletedUserReply returns the original result when no repair is needed", async () => {
  const result = await ensureCompletedUserReply({
    userText: "What is the current weather in Tokyo?",
    result: {
      text: "Tokyo is currently about 14°C with light wind.",
      sessionId: "thread_1",
    },
    continueRun: async () => {
      throw new Error("should not continue");
    },
  });

  assert.equal(result.repaired, false);
  assert.equal(result.result.text, "Tokyo is currently about 14°C with light wind.");
});

test("ensureCompletedUserReply repairs a placeholder-only lookup reply by continuing the session", async () => {
  const prompts: string[] = [];
  const result = await ensureCompletedUserReply({
    userText: "What is the current weather in Tokyo?",
    result: {
      text: "I will check that.",
      sessionId: "thread_1",
    },
    continueRun: async (sessionId, prompt) => {
      prompts.push(`${sessionId}:${prompt}`);
      return {
        text: "Tokyo is currently about 14°C with light wind.",
        sessionId,
      };
    },
  });

  assert.equal(result.repaired, true);
  assert.equal(result.result.text, "Tokyo is currently about 14°C with light wind.");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] || "", /thread_1:/);
});

test("ensureCompletedUserReply throws when the repaired reply is still only a placeholder", async () => {
  await assert.rejects(
    ensureCompletedUserReply({
      userText: "What is the current weather in Tokyo?",
      result: {
        text: "I will check that.",
        sessionId: "thread_1",
      },
      continueRun: async (sessionId) => ({
        text: "Let me check.",
        sessionId,
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderIncompleteReplyError);
      return true;
    },
  );
});

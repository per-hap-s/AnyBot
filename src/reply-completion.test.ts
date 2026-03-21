import test from "node:test";
import assert from "node:assert/strict";

import {
  ProviderIncompleteReplyError,
  buildIncompleteReplyRecoveryPrompt,
  ensureCompletedUserReply,
  isLikelyLookupTask,
  looksLikeExplicitFailureReply,
  looksLikeProgressOnlyReply,
  looksLikeWeakNonAnswerReply,
  shouldRepairIncompleteReply,
} from "./reply-completion.js";

test("isLikelyLookupTask detects common lookup-style user requests", () => {
  assert.equal(isLikelyLookupTask("What is the current weather in Tokyo?"), true);
  assert.equal(isLikelyLookupTask("帮我查一下今天东京天气"), true);
  assert.equal(isLikelyLookupTask("Reply with exactly 'I will check that.'"), false);
});

test("looksLikeProgressOnlyReply detects short placeholder replies", () => {
  assert.equal(looksLikeProgressOnlyReply("I will check that."), true);
  assert.equal(looksLikeProgressOnlyReply("我先查一下。"), true);
  assert.equal(looksLikeProgressOnlyReply("Tokyo is currently about 14°C with light wind."), false);
});

test("looksLikeProgressOnlyReply detects expanded placeholder replies", () => {
  assert.equal(
    looksLikeProgressOnlyReply("我先查一下公开信息，确认它到底是项目、产品还是网站。"),
    true,
  );
  assert.equal(
    looksLikeProgressOnlyReply("我查了一下，ClawHub 是一个项目聚合站。"),
    false,
  );
});

test("looksLikeExplicitFailureReply distinguishes explicit vs vague failure replies", () => {
  assert.equal(
    looksLikeExplicitFailureReply("抱歉，我现在无法访问网络，所以不能确认最新信息。"),
    true,
  );
  assert.equal(
    looksLikeExplicitFailureReply("我不确定。"),
    false,
  );
});

test("looksLikeWeakNonAnswerReply detects vague unresolved lookup endings", () => {
  assert.equal(looksLikeWeakNonAnswerReply("Not sure."), true);
  assert.equal(looksLikeWeakNonAnswerReply("I don't know."), true);
  assert.equal(
    looksLikeWeakNonAnswerReply("Sorry, I can't access the network right now, so I can't confirm the latest info."),
    false,
  );
});

test("shouldRepairIncompleteReply only triggers for lookup requests with unresolved replies", () => {
  assert.equal(
    shouldRepairIncompleteReply("帮我查一下今天东京天气", "我先查一下。"),
    true,
  );
  assert.equal(
    shouldRepairIncompleteReply("Give me a quick lookup for ClawHub.", "Not sure."),
    true,
  );
  assert.equal(
    shouldRepairIncompleteReply("Give me a quick lookup for ClawHub.", "Sorry, I can't access the network right now, so I can't confirm the latest info."),
    false,
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

  assert.match(prompt, /without a usable final answer/i);
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

test("ensureCompletedUserReply repairs an unresolved lookup reply by continuing the session", async () => {
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

test("ensureCompletedUserReply accepts explicit failure replies after repair", async () => {
  const result = await ensureCompletedUserReply({
    userText: "What is the current weather in Tokyo?",
    result: {
      text: "Not sure.",
      sessionId: "thread_2",
    },
    continueRun: async (sessionId) => ({
      text: "Sorry, I can't access the weather source right now, so I can't confirm Tokyo weather.",
      sessionId,
    }),
  });

  assert.equal(result.repaired, true);
  assert.match(result.result.text, /can't access the weather source/i);
});

test("ensureCompletedUserReply throws when the repaired reply is still unresolved", async () => {
  await assert.rejects(
    ensureCompletedUserReply({
      userText: "What is the current weather in Tokyo?",
      result: {
        text: "I will check that.",
        sessionId: "thread_1",
      },
      continueRun: async (sessionId) => ({
        text: "Not sure.",
        sessionId,
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderIncompleteReplyError);
      return true;
    },
  );
});

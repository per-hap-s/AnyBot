import test from "node:test";
import assert from "node:assert/strict";

import { TelegramRouterClient } from "./telegram-router.js";

test("TelegramRouterClient uses hard rules for obvious queue redirects", async () => {
  const client = new TelegramRouterClient();
  const result = await client.classify({
    currentTaskSummary: "排查 Telegram 长任务超时",
    currentPhase: "stable_running",
    recentUserMessages: ["继续看超时问题"],
    incomingMessages: ["别做这个了，另外开一个，排队处理"],
  });

  assert.equal(result.intentType, "queue");
  assert.equal(result.confidence, 1);
});

test("TelegramRouterClient uses hard rules for obvious supplements", async () => {
  const client = new TelegramRouterClient();
  const result = await client.classify({
    currentTaskSummary: "排查 Telegram 长任务超时",
    currentPhase: "early_running",
    recentUserMessages: ["继续看超时问题"],
    incomingMessages: ["再加一个限制，最后简单说，不要贴长路径"],
  });

  assert.equal(result.intentType, "supplement");
  assert.ok(result.confidence >= 0.9);
});

test("TelegramRouterClient falls back to unclear when router sidecar is disabled", async () => {
  const client = new TelegramRouterClient();
  const result = await client.classify({
    currentTaskSummary: "排查 Telegram 长任务超时",
    currentPhase: "starting",
    recentUserMessages: ["继续看超时问题"],
    incomingMessages: ["这个你看着办"],
  });

  assert.equal(result.intentType, "unclear");
  assert.equal(result.confidence, 0);
});

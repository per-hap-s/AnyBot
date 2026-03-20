import test from "node:test";
import assert from "node:assert/strict";

import {
  getTelegramStatusPhaseRank,
  mapProviderEventToTelegramStatus,
  TELEGRAM_COMMAND_STATUS_TEXT,
  TELEGRAM_FINALIZING_STATUS_TEXT,
  TELEGRAM_RUNNING_STATUS_TEXT,
  TELEGRAM_TOOL_STATUS_TEXT,
  TELEGRAM_WEB_STATUS_TEXT,
} from "./telegram-status.js";

test("mapProviderEventToTelegramStatus maps thread and reasoning events to understanding", () => {
  const threadStarted = mapProviderEventToTelegramStatus({
    type: "thread.started",
  });
  const reasoning = mapProviderEventToTelegramStatus({
    type: "item.completed",
    itemType: "reasoning",
  });

  assert.deepEqual(threadStarted, {
    phase: "processing",
    text: TELEGRAM_RUNNING_STATUS_TEXT,
  });
  assert.deepEqual(reasoning, {
    phase: "processing",
    text: TELEGRAM_RUNNING_STATUS_TEXT,
  });
});

test("mapProviderEventToTelegramStatus attaches concise detail for work events", () => {
  const command = mapProviderEventToTelegramStatus({
    type: "item.started",
    itemType: "command_execution",
    command: "npm run check",
  });
  const webSearch = mapProviderEventToTelegramStatus({
    type: "item.started",
    itemType: "web_search",
    query: "Codex non-interactive json events",
  });
  const tool = mapProviderEventToTelegramStatus({
    type: "item.completed",
    itemType: "mcp_tool_call",
    toolName: "search_openai_docs",
  });

  assert.equal(command?.phase, "processing");
  assert.equal(command?.text, `${TELEGRAM_COMMAND_STATUS_TEXT}：npm run check`);
  assert.equal(webSearch?.text, `${TELEGRAM_WEB_STATUS_TEXT}：Codex non-interactive json events`);
  assert.equal(tool?.text, `${TELEGRAM_TOOL_STATUS_TEXT}：search_openai_docs`);
});

test("mapProviderEventToTelegramStatus only finalizes on completed agent messages", () => {
  const started = mapProviderEventToTelegramStatus({
    type: "item.started",
    itemType: "agent_message",
  });
  const completed = mapProviderEventToTelegramStatus({
    type: "item.completed",
    itemType: "agent_message",
  });

  assert.equal(started, null);
  assert.deepEqual(completed, {
    phase: "processing",
    text: TELEGRAM_FINALIZING_STATUS_TEXT,
  });
});

test("getTelegramStatusPhaseRank preserves forward-only phase ordering", () => {
  assert.equal(getTelegramStatusPhaseRank("received") < getTelegramStatusPhaseRank("processing"), true);
  assert.equal(getTelegramStatusPhaseRank("processing") < getTelegramStatusPhaseRank("sending"), true);
});

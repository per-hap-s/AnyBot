import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramCommandStatus,
  buildTelegramToolStatus,
  buildTelegramWebStatus,
  getTelegramStatusPhaseRank,
  mapProviderEventToTelegramStatus,
  TELEGRAM_COMMAND_STATUS_TEXT,
  TELEGRAM_FILE_STATUS_TEXT,
  TELEGRAM_FINALIZING_STATUS_TEXT,
  TELEGRAM_REPAIRING_STATUS_TEXT,
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

test("mapProviderEventToTelegramStatus attaches sanitized detail for work events", () => {
  const command = mapProviderEventToTelegramStatus({
    type: "item.started",
    itemType: "command_execution",
    command: "C:\\tools\\npm.cmd run check -- --very-long-flag",
  });
  const webSearch = mapProviderEventToTelegramStatus({
    type: "item.started",
    itemType: "web_search",
    query: "Codex non-interactive json events https://example.com/debug?token=secret",
  });
  const tool = mapProviderEventToTelegramStatus({
    type: "item.completed",
    itemType: "mcp_tool_call",
    toolName: "mcp/search_openai_docs",
  });
  const fileChange = mapProviderEventToTelegramStatus({
    type: "item.completed",
    itemType: "file_change",
    aggregatedOutputPreview: "updated D:\\CodexProjects\\AnyBot\\src\\channels\\telegram.ts",
  });

  assert.equal(command?.phase, "processing");
  assert.equal(command?.text, `${TELEGRAM_COMMAND_STATUS_TEXT}：npm.cmd run`);
  assert.equal(webSearch?.text, `${TELEGRAM_WEB_STATUS_TEXT}：Codex non-interactive json ev...`);
  assert.equal(tool?.text, `${TELEGRAM_TOOL_STATUS_TEXT}：search_openai_docs`);
  assert.equal(fileChange?.text, TELEGRAM_FILE_STATUS_TEXT);
});

test("telegram status detail builders strip long paths and URLs", () => {
  assert.equal(
    buildTelegramCommandStatus("D:\\workspace\\node_modules\\.bin\\tsx.cmd src\\server.ts"),
    `${TELEGRAM_COMMAND_STATUS_TEXT}：tsx.cmd`,
  );
  assert.equal(
    buildTelegramWebStatus("https://example.com/search?q=codex+status"),
    TELEGRAM_WEB_STATUS_TEXT,
  );
  assert.equal(
    buildTelegramToolStatus("plugins/search_openai_docs"),
    `${TELEGRAM_TOOL_STATUS_TEXT}：search_openai_docs`,
  );
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

test("mapProviderEventToTelegramStatus exposes repair-in-progress events", () => {
  const repair = mapProviderEventToTelegramStatus({
    type: "reply.repair.started",
    itemType: "completion_repair",
  });

  assert.deepEqual(repair, {
    phase: "processing",
    text: TELEGRAM_REPAIRING_STATUS_TEXT,
  });
});

test("getTelegramStatusPhaseRank preserves forward-only phase ordering", () => {
  assert.equal(getTelegramStatusPhaseRank("received") < getTelegramStatusPhaseRank("processing"), true);
  assert.equal(getTelegramStatusPhaseRank("processing") < getTelegramStatusPhaseRank("sending"), true);
});

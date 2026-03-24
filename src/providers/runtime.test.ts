import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  ProviderTimeoutError,
  scheduleProviderForceKill,
  shouldRetryFreshSessionAfterTimeout,
} from "./codex.js";
import {
  DEFAULT_PROVIDER_LONG_STEP_STALL_TIMEOUT_MS,
  DEFAULT_PROVIDER_MAX_RUNTIME_MS,
  getProviderLongStepKey,
  isProviderLongStepItemType,
  isProviderProgressEvent,
  normalizeProviderRuntimeEvent,
  shouldTriggerProviderIdleTimeout,
  shouldTriggerProviderLongStepStallTimeout,
} from "./runtime.js";

test("DEFAULT_PROVIDER_MAX_RUNTIME_MS defaults to 60 minutes", () => {
  assert.equal(DEFAULT_PROVIDER_MAX_RUNTIME_MS, 3_600_000);
});

test("DEFAULT_PROVIDER_LONG_STEP_STALL_TIMEOUT_MS defaults to 10 minutes", () => {
  assert.equal(DEFAULT_PROVIDER_LONG_STEP_STALL_TIMEOUT_MS, 600_000);
});

test("normalizeProviderRuntimeEvent extracts command execution details", () => {
  const event = normalizeProviderRuntimeEvent({
    type: "item.started",
    thread_id: "thread_123",
    item: {
      id: "item_1",
      type: "command_execution",
      status: "in_progress",
      command: "npm run check",
      aggregated_output: "line one\nline two",
    },
  });

  assert.equal(event.type, "item.started");
  assert.equal(event.threadId, "thread_123");
  assert.equal(event.itemId, "item_1");
  assert.equal(event.itemType, "command_execution");
  assert.equal(event.itemStatus, "in_progress");
  assert.equal(event.command, "npm run check");
  assert.equal(event.aggregatedOutputPreview, "line one line two");
  assert.equal(event.progressKind, "progress");
  assert.equal(isProviderProgressEvent(event), true);
});

test("normalizeProviderRuntimeEvent extracts todo list progress summary", () => {
  const event = normalizeProviderRuntimeEvent({
    type: "item.started",
    item: {
      id: "todo_1",
      type: "todo_list",
      items: [
        { text: "确认用户想要的输出格式", completed: true },
        { text: "整理一个最小两步计划", completed: true },
        { text: "返回最终中文结果并避免展开清单", completed: false },
      ],
    },
  });

  assert.equal(event.itemId, "todo_1");
  assert.equal(event.itemType, "todo_list");
  assert.equal(event.todoCompleted, 2);
  assert.equal(event.todoTotal, 3);
  assert.equal(event.todoCurrentStep, "返回最终中文结果并避免展开清单");
  assert.equal(event.progressKind, "progress");
});

test("normalizeProviderRuntimeEvent treats turn.completed as progress", () => {
  const turnCompleted = normalizeProviderRuntimeEvent({
    type: "turn.completed",
  });
  const noisyItem = normalizeProviderRuntimeEvent({
    type: "item.completed",
    item: {
      type: "unknown_item",
    },
  });

  assert.equal(turnCompleted.progressKind, "progress");
  assert.equal(isProviderProgressEvent(turnCompleted), true);
  assert.equal(noisyItem.progressKind, "informational");
  assert.equal(isProviderProgressEvent(noisyItem), false);
});

test("long-running step helpers suppress idle timeout while a tracked step is active", () => {
  const started = normalizeProviderRuntimeEvent({
    type: "item.started",
    item: {
      id: "cmd_1",
      type: "command_execution",
    },
  });

  assert.equal(isProviderLongStepItemType(started.itemType), true);
  assert.equal(getProviderLongStepKey(started), "cmd_1");
  assert.equal(shouldTriggerProviderIdleTimeout(0, 1, 120_001, 120_000), false);
  assert.equal(shouldTriggerProviderIdleTimeout(0, 0, 120_001, 120_000), true);
  assert.equal(shouldTriggerProviderLongStepStallTimeout(0, 1, 599_999, 600_000), false);
  assert.equal(shouldTriggerProviderLongStepStallTimeout(0, 1, 600_001, 600_000), true);
  assert.equal(shouldTriggerProviderLongStepStallTimeout(0, 0, 600_001, 600_000), false);
});

test("shouldRetryFreshSessionAfterTimeout only allows idle timeouts with no progress", () => {
  assert.equal(
    shouldRetryFreshSessionAfterTimeout(new ProviderTimeoutError("idle", 120_000, false)),
    true,
  );
  assert.equal(
    shouldRetryFreshSessionAfterTimeout(new ProviderTimeoutError("idle", 120_000, true)),
    false,
  );
  assert.equal(
    shouldRetryFreshSessionAfterTimeout(new ProviderTimeoutError("max_runtime", 3_600_000, false)),
    false,
  );
  assert.equal(
    shouldRetryFreshSessionAfterTimeout(new ProviderTimeoutError("long_step_stalled", 600_000, true)),
    false,
  );
});

test("scheduleProviderForceKill escalates only when the process is still open", async () => {
  let closed = false;
  const signals: string[] = [];
  const timer = scheduleProviderForceKill(
    () => closed,
    (signal) => {
      signals.push(signal);
    },
    10,
  );

  await delay(25);
  clearTimeout(timer);
  assert.deepEqual(signals, ["SIGKILL"]);

  closed = true;
  const skippedSignals: string[] = [];
  const skippedTimer = scheduleProviderForceKill(
    () => closed,
    (signal) => {
      skippedSignals.push(signal);
    },
    10,
  );

  await delay(25);
  clearTimeout(skippedTimer);
  assert.deepEqual(skippedSignals, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  ProviderTimeoutError,
  scheduleProviderForceKill,
  shouldRetryFreshSessionAfterTimeout,
} from "./codex.js";
import {
  getProviderLongStepKey,
  isProviderLongStepItemType,
  isProviderProgressEvent,
  normalizeProviderRuntimeEvent,
  shouldTriggerProviderIdleTimeout,
} from "./runtime.js";

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
    shouldRetryFreshSessionAfterTimeout(new ProviderTimeoutError("max_runtime", 1_800_000, false)),
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

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { ProviderTimeoutError } from "../providers/index.js";
import type { TelegramMessage } from "../telegram.js";
import {
  cleanupTelegramChatState,
  getTelegramBatchFailureText,
  StatusMessageController,
  TelegramRuntimeStatusTracker,
} from "./telegram.js";
import {
  TELEGRAM_COMMAND_STATUS_TEXT,
  TELEGRAM_FINALIZING_STATUS_TEXT,
  TELEGRAM_IMAGE_STATUS_TEXT,
  TELEGRAM_RECEIVED_STATUS_TEXT,
  TELEGRAM_SENDING_STATUS_TEXT,
} from "./telegram-status.js";

function createTelegramMessage(messageId: number): TelegramMessage {
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: 1,
      type: "private",
    },
  } as unknown as TelegramMessage;
}

test("StatusMessageController does not recreate a sealed status message", async () => {
  const calls: string[] = [];
  const controller = new StatusMessageController("token", 1, 10, {
    send: async () => {
      calls.push("send");
      return createTelegramMessage(100);
    },
    edit: async () => {
      calls.push("edit");
      return true as any;
    },
    delete: async () => {
      calls.push("delete");
      return true as any;
    },
  });

  await controller.show("已收到消息");
  await controller.delete();
  await controller.show("正在执行命令");

  assert.deepEqual(calls, ["send", "delete"]);
  assert.equal(controller.isSealed, true);
});

test("TelegramRuntimeStatusTracker keeps the latest processing text and blocks updates after sending", async () => {
  const shown: string[] = [];
  const tracker = new TelegramRuntimeStatusTracker(
    {
      show: async (text: string) => {
        shown.push(text);
      },
    },
    () => true,
    0,
  );

  tracker.prime(TELEGRAM_RECEIVED_STATUS_TEXT);
  tracker.handleProviderEvent({
    type: "item.completed",
    itemType: "agent_message",
  });
  await delay(0);
  tracker.handleProviderEvent({
    type: "item.started",
    itemType: "command_execution",
    command: "npm run check",
  });
  await delay(0);
  await tracker.showSending();
  tracker.handleProviderEvent({
    type: "item.started",
    itemType: "command_execution",
    command: "npm test",
  });
  await delay(0);

  assert.deepEqual(shown, [
    TELEGRAM_FINALIZING_STATUS_TEXT,
    `${TELEGRAM_COMMAND_STATUS_TEXT}：npm run`,
    TELEGRAM_SENDING_STATUS_TEXT,
  ]);
});

test("TelegramRuntimeStatusTracker keeps image understanding until the first work item", async () => {
  const shown: string[] = [];
  const tracker = new TelegramRuntimeStatusTracker(
    {
      show: async (text: string) => {
        shown.push(text);
      },
    },
    () => true,
    0,
  );

  tracker.prime(TELEGRAM_RECEIVED_STATUS_TEXT);
  await tracker.showImageUnderstanding();
  tracker.handleProviderEvent({
    type: "thread.started",
  });
  await delay(0);
  tracker.handleProviderEvent({
    type: "item.started",
    itemType: "command_execution",
    command: "npm run check",
  });
  await delay(0);

  assert.deepEqual(shown, [
    TELEGRAM_IMAGE_STATUS_TEXT,
    `${TELEGRAM_COMMAND_STATUS_TEXT}：npm run`,
  ]);
});

test("TelegramRuntimeStatusTracker drops delayed updates after dispose", async () => {
  const shown: string[] = [];
  const tracker = new TelegramRuntimeStatusTracker(
    {
      show: async (text: string) => {
        shown.push(text);
      },
    },
    () => true,
    20,
  );

  tracker.prime(TELEGRAM_RECEIVED_STATUS_TEXT);
  tracker.handleProviderEvent({
    type: "item.started",
    itemType: "command_execution",
    command: "npm run check",
  });
  tracker.dispose();
  await delay(40);

  assert.deepEqual(shown, []);
});

test("getTelegramBatchFailureText distinguishes idle timeout, max runtime, and generic failures", () => {
  assert.equal(
    getTelegramBatchFailureText(new ProviderTimeoutError("idle", 120_000, false)),
    "本次任务因长时间无进展而超时，请稍后重试。",
  );
  assert.equal(
    getTelegramBatchFailureText(new ProviderTimeoutError("max_runtime", 3_600_000, true)),
    "本次任务已达到最长运行时长（60 分钟），请拆分任务后重试。",
  );
  assert.equal(
    getTelegramBatchFailureText(new Error("boom")),
    "处理消息时出错了，请稍后再试。",
  );
});

test("cleanupTelegramChatState disposes trackers, aborts running work, and deletes all status messages", async () => {
  const deleted: string[] = [];
  let disposeCount = 0;
  let abortedCount = 0;
  const abortController = new AbortController();
  const originalAbort = abortController.abort.bind(abortController);
  abortController.abort = () => {
    abortedCount += 1;
    originalAbort();
  };

  const makeStatus = (name: string) => ({
    delete: async () => {
      deleted.push(name);
    },
  }) as unknown as StatusMessageController;

  const state: Parameters<typeof cleanupTelegramChatState>[0] = {
    running: {
      id: "run_1",
      batch: {
        id: "batch_1",
        items: [],
        status: makeStatus("running"),
      },
      abortController,
      generation: 1,
      startText: TELEGRAM_RECEIVED_STATUS_TEXT,
      runtimeStatusTracker: {
        dispose: () => {
          disposeCount += 1;
        },
      } as TelegramRuntimeStatusTracker,
    },
    decision: {
      id: "decision_1",
      batch: {
        id: "batch_2",
        items: [],
        status: makeStatus("decision"),
      },
      timer: null,
    },
    queued: [{
      id: "batch_3",
      items: [],
      status: makeStatus("queued"),
    }],
    pendingRestart: {
      batch: {
        id: "batch_4",
        items: [],
        status: makeStatus("pendingRestart"),
      },
      earliestStartAt: Date.now(),
      combinedItemCount: 1,
    },
    generation: 1,
  };

  await cleanupTelegramChatState(state);

  assert.equal(disposeCount, 1);
  assert.equal(abortedCount, 1);
  assert.deepEqual(deleted.sort(), ["decision", "pendingRestart", "queued", "running"]);
  assert.equal(state.running, null);
  assert.equal(state.decision, null);
  assert.equal(state.pendingRestart, null);
  assert.deepEqual(state.queued, []);
});

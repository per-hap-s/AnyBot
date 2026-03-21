import test from "node:test";
import assert from "node:assert/strict";

import {
  createTelegramTask,
  createTelegramTaskInput,
  createTelegramAttempt,
  getTelegramPollState,
  getTelegramTaskById,
  getTelegramAttemptById,
  listTelegramTaskInputsUpToRevision,
  saveTelegramPollState,
  updateTelegramTask,
  type TelegramAttempt,
  type TelegramTask,
  type TelegramTaskInput,
} from "./db.js";

function createTask(chatId: string): TelegramTask {
  const now = Date.now();
  return {
    id: `task_${now}_${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    status: "queued",
    queueOrder: now,
    currentRevision: 1,
    activeAttemptId: null,
    providerSessionId: null,
    latestStatusMessageId: null,
    latestResultMessageId: null,
    decisionStatus: null,
    decisionDeadlineAt: null,
    currentPhase: "merge_window",
    cancelRequestedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

test("telegram V2 db helpers persist task, inputs, and attempts", () => {
  const task = createTask(`chat_${Date.now()}`);
  createTelegramTask(task);

  const input: TelegramTaskInput = {
    id: `input_${Date.now()}`,
    taskId: task.id,
    revision: 1,
    sequence: 1,
    kind: "text",
    telegramMessageId: 100,
    text: "Message 1: hello",
    attachmentJson: null,
    createdAt: Date.now(),
  };
  createTelegramTaskInput(input);

  const attempt: TelegramAttempt = {
    id: `attempt_${Date.now()}`,
    taskId: task.id,
    revision: 1,
    status: "running",
    inputSnapshotJson: JSON.stringify([input]),
    providerSessionIdBefore: null,
    providerSessionIdAfter: null,
    hasLongStep: false,
    lastEventAt: null,
    timeoutKind: null,
    resultText: null,
    errorText: null,
    startedAt: Date.now(),
    finishedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  createTelegramAttempt(attempt);

  const storedTask = getTelegramTaskById(task.id);
  const storedAttempt = getTelegramAttemptById(attempt.id);
  const storedInputs = listTelegramTaskInputsUpToRevision(task.id, 1);

  assert.ok(storedTask);
  assert.equal(storedTask.currentPhase, "merge_window");
  assert.ok(storedAttempt);
  assert.equal(storedAttempt.status, "running");
  assert.deepEqual(storedInputs.map((item) => item.text), ["Message 1: hello"]);

  updateTelegramTask({
    ...storedTask,
    activeAttemptId: attempt.id,
    currentPhase: "starting",
    updatedAt: Date.now(),
  });

  const updatedTask = getTelegramTaskById(task.id);
  assert.equal(updatedTask?.activeAttemptId, attempt.id);
  assert.equal(updatedTask?.currentPhase, "starting");
});

test("telegram V2 db helpers persist polling state", () => {
  const channel = `telegram_test_${Date.now()}`;
  saveTelegramPollState({
    channel,
    lastUpdateId: 12345,
    updatedAt: Date.now(),
  });

  const stored = getTelegramPollState(channel);
  assert.equal(stored?.lastUpdateId, 12345);
});

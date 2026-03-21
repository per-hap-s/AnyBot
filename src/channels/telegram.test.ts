import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { ProviderTimeoutError } from "../providers/index.js";
import { ProviderIncompleteReplyError } from "../reply-completion.js";
import type { TelegramMessage } from "../telegram.js";
import {
  TelegramChannel,
  cleanupTelegramChatState,
  getTelegramBatchFailureText,
  StatusMessageController,
  TelegramRuntimeStatusTracker,
} from "./telegram.js";
import {
  createTelegramAttempt,
  createTelegramTask,
  createTelegramTaskInput,
  getTelegramAttemptById,
  getTelegramCurrentTaskByChat,
  getTelegramPendingDecisionByChat,
  getTelegramPollState,
  getTelegramTaskById,
  listTelegramAttemptsByTask,
  listTelegramTaskInputs,
  saveTelegramPollState,
  type TelegramAttempt,
  type TelegramTask,
  type TelegramTaskInput,
} from "../web/db.js";
import {
  TELEGRAM_COMMAND_STATUS_TEXT,
  TELEGRAM_FINALIZING_STATUS_TEXT,
  TELEGRAM_IMAGE_STATUS_TEXT,
  TELEGRAM_REPAIRING_STATUS_TEXT,
  TELEGRAM_RECEIVED_STATUS_TEXT,
  TELEGRAM_SENDING_STATUS_TEXT,
  TELEGRAM_RUNNING_STATUS_TEXT,
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

function createTask(overrides: Partial<TelegramTask> = {}): TelegramTask {
  const now = Date.now();
  return {
    id: `task_${now}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: `chat_${now}_${Math.random().toString(36).slice(2, 6)}`,
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
    ...overrides,
  };
}

function createAttempt(task: TelegramTask, overrides: Partial<TelegramAttempt> = {}): TelegramAttempt {
  const now = Date.now();
  return {
    id: `attempt_${now}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.id,
    revision: task.currentRevision,
    status: "running",
    inputSnapshotJson: "[]",
    providerSessionIdBefore: task.providerSessionId,
    providerSessionIdAfter: null,
    hasLongStep: false,
    lastEventAt: null,
    timeoutKind: null,
    resultText: null,
    errorText: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTaskInput(
  task: TelegramTask,
  revision: number,
  sequence: number,
  text: string,
): TelegramTaskInput {
  return {
    id: `input_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.id,
    revision,
    sequence,
    kind: "text",
    telegramMessageId: 100 + sequence,
    text,
    attachmentJson: null,
    createdAt: Date.now(),
  };
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
      return true as never;
    },
    delete: async () => {
      calls.push("delete");
      return true as never;
    },
  });

  await controller.show("已收到消息");
  await controller.delete();
  await controller.show("正在执行命令");

  assert.deepEqual(calls, ["send", "delete"]);
  assert.equal(controller.isSealed, true);
});

test("StatusMessageController ignores Telegram no-op edit errors for identical content", async () => {
  const calls: string[] = [];
  const controller = new StatusMessageController("token", 1, 10, {
    send: async () => createTelegramMessage(100),
    edit: async () => {
      calls.push("edit");
      throw new Error("Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
    },
    delete: async () => true as never,
  });

  controller.seedExisting(createTelegramMessage(100));
  await controller.show("已收到消息", { clearKeyboard: true });
  await controller.show("已收到消息", { clearKeyboard: true });

  assert.deepEqual(calls, ["edit"]);
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

test("TelegramRuntimeStatusTracker shows repair progress before finalizing a repaired reply", async () => {
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
    type: "thread.started",
  });
  await delay(0);
  tracker.handleProviderEvent({
    type: "reply.repair.started",
    itemType: "completion_repair",
  });
  await delay(0);
  tracker.handleProviderEvent({
    type: "item.completed",
    itemType: "agent_message",
  });
  await delay(0);
  await tracker.showSending();

  assert.deepEqual(shown, [
    TELEGRAM_RUNNING_STATUS_TEXT,
    TELEGRAM_REPAIRING_STATUS_TEXT,
    TELEGRAM_FINALIZING_STATUS_TEXT,
    TELEGRAM_SENDING_STATUS_TEXT,
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

test("getTelegramBatchFailureText distinguishes incomplete reply, timeouts, and generic failures", () => {
  assert.equal(
    getTelegramBatchFailureText(new ProviderIncompleteReplyError("I will check that.")),
    "这次查询没有拿到结果，也没有明确失败原因，请稍后重试。",
  );
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
      taskId: "task_1",
      attemptId: "attempt_1",
      status: makeStatus("running"),
      abortController,
      runtimeStatusTracker: {
        dispose: () => {
          disposeCount += 1;
        },
      } as TelegramRuntimeStatusTracker,
    },
    decision: {
      taskId: "decision_1",
      status: makeStatus("decision"),
    },
  };

  await cleanupTelegramChatState(state);

  assert.equal(disposeCount, 1);
  assert.equal(abortedCount, 1);
  assert.deepEqual(deleted.sort(), ["decision", "running"]);
  assert.equal(state.running, null);
  assert.equal(state.decision, null);
});

test("TelegramChannel recovery requeues persisted tasks and resets recoverable attempts", () => {
  const channel = new TelegramChannel();
  const now = Date.now();
  const runningTask = createTask({
    chatId: `recover_running_${now}`,
    status: "running",
    currentRevision: 2,
    currentPhase: "stable_running",
    cancelRequestedAt: now - 1_000,
  });
  const waitingTask = createTask({
    chatId: `recover_waiting_${now}`,
    status: "waiting_next_attempt",
    currentRevision: 3,
    currentPhase: "stable_running",
    cancelRequestedAt: now - 2_000,
  });
  const pendingAttempt = createAttempt(runningTask, {
    revision: 2,
    status: "running",
  });
  const supersededAttempt = createAttempt(waitingTask, {
    revision: 1,
    status: "running",
  });

  runningTask.activeAttemptId = pendingAttempt.id;
  waitingTask.activeAttemptId = supersededAttempt.id;

  createTelegramTask(runningTask);
  createTelegramTask(waitingTask);
  createTelegramAttempt(pendingAttempt);
  createTelegramAttempt(supersededAttempt);

  (channel as unknown as { recoverPersistedTelegramTasks: () => void }).recoverPersistedTelegramTasks();

  const recoveredRunningTask = getTelegramTaskById(runningTask.id);
  const recoveredWaitingTask = getTelegramTaskById(waitingTask.id);
  const recoveredPendingAttempt = getTelegramAttemptById(pendingAttempt.id);
  const recoveredSupersededAttempt = getTelegramAttemptById(supersededAttempt.id);

  assert.equal(recoveredRunningTask?.status, "queued");
  assert.equal(recoveredRunningTask?.activeAttemptId, null);
  assert.equal(recoveredRunningTask?.cancelRequestedAt, null);
  assert.equal(recoveredWaitingTask?.status, "queued");
  assert.equal(recoveredWaitingTask?.activeAttemptId, null);
  assert.equal(recoveredWaitingTask?.cancelRequestedAt, null);
  assert.equal(recoveredPendingAttempt?.status, "pending");
  assert.equal(recoveredSupersededAttempt?.status, "superseded");
});

test("TelegramChannel recovery keeps pending decisions intact", () => {
  const channel = new TelegramChannel();
  const now = Date.now();
  const currentTask = createTask({
    chatId: `recover_decision_${now}`,
    status: "running",
    currentPhase: "stable_running",
  });
  const currentAttempt = createAttempt(currentTask, {
    status: "running",
    hasLongStep: true,
  });
  currentTask.activeAttemptId = currentAttempt.id;

  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    queueOrder: currentTask.queueOrder + 1,
  });

  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);
  createTelegramAttempt(currentAttempt);
  createTelegramTaskInput(createTaskInput(decisionTask, 1, 1, "补充一个边界条件"));

  (channel as unknown as { recoverPersistedTelegramTasks: () => void }).recoverPersistedTelegramTasks();

  const recoveredCurrentTask = getTelegramTaskById(currentTask.id);
  const recoveredDecisionTask = getTelegramPendingDecisionByChat(currentTask.chatId);
  const recoveredAttempt = getTelegramAttemptById(currentAttempt.id);

  assert.equal(recoveredCurrentTask?.status, "queued");
  assert.equal(recoveredDecisionTask?.id, decisionTask.id);
  assert.equal(recoveredDecisionTask?.status, "decision_pending");
  assert.equal(recoveredDecisionTask?.decisionStatus, "pending");
  assert.equal(recoveredAttempt?.status, "pending");
});

test("TelegramChannel supplement during early running restarts the current attempt", async () => {
  const channel = new TelegramChannel();
  const now = Date.now();
  const currentTask = createTask({
    chatId: `supplement_restart_${now}`,
    status: "running",
    currentPhase: "early_running",
    providerSessionId: "session_current",
  });
  const currentAttempt = createAttempt(currentTask, {
    status: "running",
    hasLongStep: false,
  });
  currentTask.activeAttemptId = currentAttempt.id;

  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    queueOrder: currentTask.queueOrder + 1,
  });
  const decisionInput = createTaskInput(decisionTask, 1, 1, "再补充一个限制");

  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);
  createTelegramAttempt(currentAttempt);
  createTelegramTaskInput(decisionInput);

  let abortCount = 0;
  const abortController = new AbortController();
  const originalAbort = abortController.abort.bind(abortController);
  abortController.abort = () => {
    abortCount += 1;
    originalAbort();
  };

  const state = (channel as unknown as {
    getChatState: (chatId: string) => {
      running: {
        taskId: string;
        attemptId: string;
        abortController: AbortController;
      } | null;
      decision: null;
    };
  }).getChatState(currentTask.chatId);
  state.running = {
    taskId: currentTask.id,
    attemptId: currentAttempt.id,
    abortController,
  } as never;

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "supplement");

  const updatedTask = getTelegramTaskById(currentTask.id);
  const updatedDecision = getTelegramTaskById(decisionTask.id);
  const migratedInputs = listTelegramTaskInputs(currentTask.id).filter((input) => input.revision === 2);

  assert.equal(updatedTask?.currentRevision, 2);
  assert.equal(updatedTask?.status, "running");
  assert.equal(updatedTask?.currentPhase, "starting");
  assert.notEqual(updatedTask?.cancelRequestedAt, null);
  assert.equal(updatedDecision?.status, "cancelled");
  assert.equal(migratedInputs.length, 1);
  assert.equal(migratedInputs[0]?.text, decisionInput.text);
  assert.equal(abortCount, 1);
});

test("TelegramChannel supplement after a long step waits for the next attempt", async () => {
  const channel = new TelegramChannel();
  const now = Date.now();
  const currentTask = createTask({
    chatId: `supplement_wait_${now}`,
    status: "running",
    currentPhase: "stable_running",
    providerSessionId: "session_current",
  });
  const currentAttempt = createAttempt(currentTask, {
    status: "running",
    hasLongStep: true,
  });
  currentTask.activeAttemptId = currentAttempt.id;

  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    queueOrder: currentTask.queueOrder + 1,
  });
  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);
  createTelegramAttempt(currentAttempt);
  createTelegramTaskInput(createTaskInput(decisionTask, 1, 1, "顺便补充输出边界"));

  let abortCount = 0;
  const abortController = new AbortController();
  const originalAbort = abortController.abort.bind(abortController);
  abortController.abort = () => {
    abortCount += 1;
    originalAbort();
  };

  const state = (channel as unknown as {
    getChatState: (chatId: string) => {
      running: {
        taskId: string;
        attemptId: string;
        abortController: AbortController;
      } | null;
      decision: null;
    };
  }).getChatState(currentTask.chatId);
  state.running = {
    taskId: currentTask.id,
    attemptId: currentAttempt.id,
    abortController,
  } as never;

  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "supplement");

  const updatedTask = getTelegramTaskById(currentTask.id);
  const updatedDecision = getTelegramTaskById(decisionTask.id);
  const migratedInputs = listTelegramTaskInputs(currentTask.id).filter((input) => input.revision === 2);

  assert.equal(updatedTask?.currentRevision, 2);
  assert.equal(updatedTask?.status, "waiting_next_attempt");
  assert.equal(updatedTask?.currentPhase, "stable_running");
  assert.equal(updatedTask?.cancelRequestedAt, null);
  assert.equal(updatedDecision?.status, "cancelled");
  assert.equal(migratedInputs.length, 1);
  assert.equal(abortCount, 0);
});

test("TelegramChannel queue decision keeps provider sessions isolated between tasks", async () => {
  const channel = new TelegramChannel();
  const now = Date.now();
  const currentTask = createTask({
    chatId: `queue_isolation_${now}`,
    status: "running",
    currentPhase: "stable_running",
    providerSessionId: "session_current",
  });
  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    queueOrder: currentTask.queueOrder + 1,
    providerSessionId: null,
  });

  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "queue");

  const updatedCurrentTask = getTelegramTaskById(currentTask.id);
  const updatedDecisionTask = getTelegramTaskById(decisionTask.id);

  assert.equal(updatedCurrentTask?.providerSessionId, "session_current");
  assert.equal(updatedDecisionTask?.status, "queued");
  assert.equal(updatedDecisionTask?.providerSessionId, null);
});

test("TelegramChannel recovered pending decision can still be resolved as queue", async () => {
  const channel = new TelegramChannel();
  const now = Date.now();
  const currentTask = createTask({
    chatId: `recover_decision_queue_${now}`,
    status: "running",
    currentPhase: "stable_running",
    providerSessionId: "session_current",
  });
  const currentAttempt = createAttempt(currentTask, {
    status: "running",
    hasLongStep: true,
  });
  currentTask.activeAttemptId = currentAttempt.id;

  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    queueOrder: currentTask.queueOrder + 1,
  });

  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);
  createTelegramAttempt(currentAttempt);
  createTelegramTaskInput(createTaskInput(decisionTask, 1, 1, "另开一个新任务"));

  (channel as unknown as { recoverPersistedTelegramTasks: () => void }).recoverPersistedTelegramTasks();
  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "queue");

  const updatedCurrentTask = getTelegramTaskById(currentTask.id);
  const updatedDecisionTask = getTelegramTaskById(decisionTask.id);

  assert.equal(updatedCurrentTask?.status, "queued");
  assert.equal(updatedCurrentTask?.providerSessionId, "session_current");
  assert.equal(updatedDecisionTask?.status, "queued");
  assert.equal(updatedDecisionTask?.decisionStatus, "resolved");
  assert.equal(updatedDecisionTask?.providerSessionId, null);
});

test("TelegramChannel pollOnce processes updates sequentially and merges same-chat backlog in order", async () => {
  let sentMessageId = 900;
  const channel = new TelegramChannel({
    getUpdates: async () => ([
      {
        update_id: 100,
        message: {
          message_id: 1000,
          date: Math.floor(Date.now() / 1000),
          text: "第一条消息",
          chat: { id: 9001, type: "private" },
        } as TelegramMessage,
      },
      {
        update_id: 101,
        message: {
          message_id: 1001,
          date: Math.floor(Date.now() / 1000),
          text: "第二条补充",
          chat: { id: 9001, type: "private" },
        } as TelegramMessage,
      },
    ]),
    sendMessage: async (_botToken, chatId, text) => ({
      message_id: sentMessageId++,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: Number(chatId), type: "private" },
    } as TelegramMessage),
    editMessageText: async () => true as never,
    deleteMessage: async () => true as never,
    updateChannelConfig: () => ({
      telegram: {
        enabled: true,
        ownerChatId: "9001",
        botToken: "test-token",
        privateOnly: true,
        allowGroups: false,
        pollingTimeoutSeconds: 30,
        finalReplyMode: "replace",
      },
    }),
  });

  const internal = channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
    callbacks: object | null;
    running: boolean;
    offset: number | null;
    pollOnce: (signal: AbortSignal) => Promise<void>;
  };

  internal.config = {
    botToken: "test-token",
    ownerChatId: "9001",
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  internal.callbacks = {
    generateReply: async () => "",
    resetSession: () => {},
    listModels: () => [],
    switchModel: () => ({ success: true, message: "" }),
    getMemoryStatus: () => "",
    listMemories: () => "",
    remember: async () => ({ success: true, message: "" }),
    updateProfile: async () => ({ success: true, message: "" }),
    forgetMemory: async () => ({ success: true, message: "" }),
    compressMemory: async () => ({ success: true, message: "" }),
    runTelegramTaskAttempt: async () => ({
      text: "",
      sessionId: null,
      repairedIncompleteReply: false,
    }),
  };
  internal.running = true;
  internal.offset = 100;

  await internal.pollOnce(new AbortController().signal);

  const task = getTelegramCurrentTaskByChat("9001");
  const pollState = getTelegramPollState("telegram");

  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.equal(listTelegramTaskInputs(task.id).length, 2);
  assert.equal(internal.offset, 102);
  assert.equal(pollState?.lastUpdateId, 101);
});

test("TelegramChannel pollOnce stops on first failed update and retries the same update later", async () => {
  let sendAttempts = 0;
  const update = {
    update_id: 200,
    message: {
      message_id: 2000,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 9200, type: "private" },
      document: {
        file_id: "file_1",
        file_unique_id: "uniq_1",
        file_name: "bad.exe",
      },
    } as TelegramMessage,
  };
  const channel = new TelegramChannel({
    getUpdates: async () => ([update]),
    sendMessage: async (_botToken, chatId, text) => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error("temporary telegram send failure");
      }
      return {
        message_id: 9201,
        date: Math.floor(Date.now() / 1000),
        text,
        chat: { id: Number(chatId), type: "private" },
      } as TelegramMessage;
    },
    editMessageText: async () => true as never,
    deleteMessage: async () => true as never,
    updateChannelConfig: () => ({
      telegram: {
        enabled: true,
        ownerChatId: "9200",
        botToken: "test-token",
        privateOnly: true,
        allowGroups: false,
        pollingTimeoutSeconds: 30,
        finalReplyMode: "replace",
      },
    }),
  });

  const internal = channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
    callbacks: object | null;
    running: boolean;
    offset: number | null;
    pollOnce: (signal: AbortSignal) => Promise<void>;
    handledUpdateIds: { has: (value: number) => boolean };
  };

  internal.config = {
    botToken: "test-token",
    ownerChatId: "9200",
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  internal.callbacks = {
    generateReply: async () => "",
    resetSession: () => {},
    listModels: () => [],
    switchModel: () => ({ success: true, message: "" }),
    getMemoryStatus: () => "",
    listMemories: () => "",
    remember: async () => ({ success: true, message: "" }),
    updateProfile: async () => ({ success: true, message: "" }),
    forgetMemory: async () => ({ success: true, message: "" }),
    compressMemory: async () => ({ success: true, message: "" }),
    runTelegramTaskAttempt: async () => ({
      text: "",
      sessionId: null,
      repairedIncompleteReply: false,
    }),
  };
  internal.running = true;
  internal.offset = 200;

  await assert.rejects(() => internal.pollOnce(new AbortController().signal));
  assert.equal(internal.offset, 200);
  assert.equal(getTelegramPollState("telegram")?.lastUpdateId, 101);
  assert.equal(internal.handledUpdateIds.has(200), false);

  await internal.pollOnce(new AbortController().signal);

  assert.equal(sendAttempts, 2);
  assert.equal(internal.offset, 201);
  assert.equal(getTelegramPollState("telegram")?.lastUpdateId, 200);
});

test("TelegramChannel pollOnce keeps later same-chat messages inside one pending decision task", async () => {
  let sentMessageId = 9300;
  const now = Date.now();
  const telegramChatId = Number(String(now).slice(-9));
  const chatId = String(telegramChatId);
  const currentTask = createTask({
    chatId,
    status: "running",
    currentPhase: "stable_running",
    updatedAt: now - 60_000,
  });
  createTelegramTask(currentTask);

  const channel = new TelegramChannel({
    getUpdates: async () => ([
      {
        update_id: 300,
        message: {
          message_id: 3000,
          date: Math.floor(Date.now() / 1000),
          text: "先来一个新方向",
          chat: { id: telegramChatId, type: "private" },
        } as TelegramMessage,
      },
      {
        update_id: 301,
        message: {
          message_id: 3001,
          date: Math.floor(Date.now() / 1000),
          text: "再补一句",
          chat: { id: telegramChatId, type: "private" },
        } as TelegramMessage,
      },
    ]),
    sendMessage: async (_botToken, chatId, text) => ({
      message_id: sentMessageId++,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: Number(chatId), type: "private" },
    } as TelegramMessage),
    editMessageText: async () => true as never,
    deleteMessage: async () => true as never,
    updateChannelConfig: () => ({
      telegram: {
        enabled: true,
        ownerChatId: chatId,
        botToken: "test-token",
        privateOnly: true,
        allowGroups: false,
        pollingTimeoutSeconds: 30,
        finalReplyMode: "replace",
      },
    }),
  });

  const internal = channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
    callbacks: object | null;
    running: boolean;
    offset: number | null;
    pollOnce: (signal: AbortSignal) => Promise<void>;
  };

  internal.config = {
    botToken: "test-token",
    ownerChatId: chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  internal.callbacks = {
    generateReply: async () => "",
    resetSession: () => {},
    listModels: () => [],
    switchModel: () => ({ success: true, message: "" }),
    getMemoryStatus: () => "",
    listMemories: () => "",
    remember: async () => ({ success: true, message: "" }),
    updateProfile: async () => ({ success: true, message: "" }),
    forgetMemory: async () => ({ success: true, message: "" }),
    compressMemory: async () => ({ success: true, message: "" }),
    runTelegramTaskAttempt: async () => ({
      text: "",
      sessionId: null,
      repairedIncompleteReply: false,
    }),
  };
  internal.running = true;
  internal.offset = 300;

  await internal.pollOnce(new AbortController().signal);

  const decisionTask = getTelegramPendingDecisionByChat(chatId);

  assert.ok(decisionTask);
  assert.equal(listTelegramTaskInputs(decisionTask.id).length, 2);
  assert.equal(internal.offset, 302);
});

test("TelegramChannel recovered pending decision rebinds and clears keyboard on queue", async () => {
  const edits: Array<{ messageId: number; replyMarkup?: { inline_keyboard: unknown[] } }> = [];
  const channel = new TelegramChannel({
    sendMessage: async () => createTelegramMessage(1),
    editMessageText: async (_botToken, _chatId, messageId, _text, opts) => {
      if (typeof messageId !== "number") {
        throw new Error("missing message id");
      }
      edits.push({
        messageId,
        replyMarkup: opts?.replyMarkup as { inline_keyboard: unknown[] } | undefined,
      });
      return true as never;
    },
    deleteMessage: async () => true as never,
  });
  const now = Date.now();
  const currentTask = createTask({
    chatId: `decision_rebind_queue_${now}`,
    status: "running",
    currentPhase: "stable_running",
    providerSessionId: "session_current",
  });
  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    latestStatusMessageId: 5555,
    queueOrder: currentTask.queueOrder + 1,
  });

  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "queue");

  const updatedDecisionTask = getTelegramTaskById(decisionTask.id);

  assert.equal(updatedDecisionTask?.status, "queued");
  assert.equal(updatedDecisionTask?.decisionStatus, "resolved");
  assert.deepEqual(edits, [{
    messageId: 5555,
    replyMarkup: { inline_keyboard: [] },
  }]);
});

test("TelegramChannel recovered pending decision rebinds and clears keyboard on supplement", async () => {
  const edits: Array<{ messageId: number; replyMarkup?: { inline_keyboard: unknown[] } }> = [];
  const channel = new TelegramChannel({
    sendMessage: async () => createTelegramMessage(1),
    editMessageText: async (_botToken, _chatId, messageId, _text, opts) => {
      if (typeof messageId !== "number") {
        throw new Error("missing message id");
      }
      edits.push({
        messageId,
        replyMarkup: opts?.replyMarkup as { inline_keyboard: unknown[] } | undefined,
      });
      return true as never;
    },
    deleteMessage: async () => true as never,
  });
  const now = Date.now();
  const currentTask = createTask({
    chatId: `decision_rebind_supplement_${now}`,
    status: "running",
    currentPhase: "stable_running",
    providerSessionId: "session_current",
  });
  const decisionTask = createTask({
    chatId: currentTask.chatId,
    status: "decision_pending",
    decisionStatus: "pending",
    latestStatusMessageId: 6666,
    queueOrder: currentTask.queueOrder + 1,
  });

  createTelegramTask(currentTask);
  createTelegramTask(decisionTask);
  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: currentTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  createTelegramTaskInput(createTaskInput(decisionTask, 1, 1, "补充一句"));

  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "supplement");

  const updatedCurrentTask = getTelegramTaskById(currentTask.id);
  const updatedDecisionTask = getTelegramTaskById(decisionTask.id);

  assert.equal(updatedCurrentTask?.currentRevision, 2);
  assert.equal(updatedCurrentTask?.status, "waiting_next_attempt");
  assert.equal(updatedDecisionTask?.status, "cancelled");
  assert.equal(updatedDecisionTask?.decisionStatus, "resolved");
  assert.deepEqual(edits, [{
    messageId: 6666,
    replyMarkup: { inline_keyboard: [] },
  }]);
});

test("TelegramChannel decision resolve does not roll back DB state when edit fails", async () => {
  const channel = new TelegramChannel({
    sendMessage: async () => createTelegramMessage(1),
    editMessageText: async () => {
      throw new Error("telegram edit failed");
    },
    deleteMessage: async () => true as never,
  });
  const now = Date.now();
  const decisionTask = createTask({
    chatId: `decision_edit_fail_${now}`,
    status: "decision_pending",
    decisionStatus: "pending",
    latestStatusMessageId: 7777,
  });

  createTelegramTask(decisionTask);

  (channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
  }).config = {
    botToken: "test-token",
    ownerChatId: decisionTask.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };

  await (channel as unknown as {
    resolveDecisionTask: (taskId: string, action: "supplement" | "queue") => Promise<void>;
  }).resolveDecisionTask(decisionTask.id, "queue");

  const updatedDecisionTask = getTelegramTaskById(decisionTask.id);
  assert.equal(updatedDecisionTask?.status, "queued");
  assert.equal(updatedDecisionTask?.decisionStatus, "resolved");
});

test("TelegramChannel resumes polling from persisted offset and processes backlog updates", async () => {
  const seenOffsets: Array<number | null> = [];
  let sentMessageId = 700;
  const channel = new TelegramChannel({
    getUpdates: async (_botToken, offset) => {
      seenOffsets.push(offset);
      return [{
        update_id: 42,
        message: {
          message_id: 4200,
          date: Math.floor(Date.now() / 1000),
          text: "继续查这个问题",
          chat: {
            id: 4242,
            type: "private",
          },
        } as TelegramMessage,
      }];
    },
    sendMessage: async (_botToken, chatId, text) => ({
      message_id: sentMessageId++,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: {
        id: Number(chatId),
        type: "private",
      },
    } as TelegramMessage),
    editMessageText: async () => true as never,
    deleteMessage: async () => true as never,
    updateChannelConfig: () => ({
      telegram: {
        enabled: true,
        ownerChatId: "4242",
        botToken: "test-token",
        privateOnly: true,
        allowGroups: false,
        pollingTimeoutSeconds: 30,
        finalReplyMode: "replace",
      },
    }),
  });

  saveTelegramPollState({
    channel: "telegram",
    lastUpdateId: 41,
    updatedAt: Date.now(),
  });

  const internal = channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
    callbacks: object | null;
    running: boolean;
    offset: number | null;
    hydrateOffset: () => void;
    pollOnce: (signal: AbortSignal) => Promise<void>;
  };

  internal.config = {
    botToken: "test-token",
    ownerChatId: "4242",
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  internal.callbacks = {
    generateReply: async () => "",
    resetSession: () => {},
    listModels: () => [],
    switchModel: () => ({ success: true, message: "" }),
    getMemoryStatus: () => "",
    listMemories: () => "",
    remember: async () => ({ success: true, message: "" }),
    updateProfile: async () => ({ success: true, message: "" }),
    forgetMemory: async () => ({ success: true, message: "" }),
    compressMemory: async () => ({ success: true, message: "" }),
    runTelegramTaskAttempt: async () => ({
      text: "",
      sessionId: null,
      repairedIncompleteReply: false,
    }),
  };
  internal.running = true;

  internal.hydrateOffset();
  assert.equal(internal.offset, 42);

  await internal.pollOnce(new AbortController().signal);

  const task = getTelegramCurrentTaskByChat("4242");
  const pollState = getTelegramPollState("telegram");

  assert.deepEqual(seenOffsets, [42]);
  assert.equal(internal.offset, 43);
  assert.equal(pollState?.lastUpdateId, 42);
  assert.equal(task?.status, "queued");
  assert.equal(task?.currentRevision, 1);
  assert.equal(listTelegramTaskInputs(task!.id).length, 1);
});

test("TelegramChannel worker restarts a recovered queued task and completes a new attempt", async () => {
  const now = Date.now();
  let sentMessageId = 800;
  let runCalls = 0;
  let commitCalls = 0;
  const channel = new TelegramChannel({
    sendMessage: async (_botToken, chatId, text) => ({
      message_id: sentMessageId++,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: {
        id: Number(chatId),
        type: "private",
      },
    } as TelegramMessage),
    editMessageText: async () => true as never,
    deleteMessage: async () => true as never,
    sendChatAction: async () => true as never,
    commitReply: async (_botToken, chatId, text) => {
      if (chatId === task.chatId && text === "浠诲姟宸茬粡缁х画瀹屾垚") {
        commitCalls += 1;
      }
      return {
        reusedExistingMessage: true,
        messages: [{
          message_id: sentMessageId++,
          date: Math.floor(Date.now() / 1000),
          text,
          chat: {
            id: Number(chatId),
            type: "private",
          },
        } as TelegramMessage],
      };
    },
  });

  const task = createTask({
    chatId: `recover_execute_${now}`,
    status: "running",
    currentRevision: 1,
    currentPhase: "stable_running",
    providerSessionId: null,
  });
  const oldAttempt = createAttempt(task, {
    revision: 1,
    status: "running",
    inputSnapshotJson: JSON.stringify([]),
  });
  task.activeAttemptId = oldAttempt.id;

  createTelegramTask(task);
  createTelegramAttempt(oldAttempt);
  createTelegramTaskInput(createTaskInput(task, 1, 1, "继续处理这个后台任务"));

  const internal = channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
    callbacks: {
      runTelegramTaskAttempt: (input: {
        taskId: string;
        userText: string;
      }) => Promise<{
        text: string;
        sessionId: string | null;
        repairedIncompleteReply: boolean;
      }>;
    } | null;
    running: boolean;
    recoverPersistedTelegramTasks: () => void;
    tickWorker: () => Promise<void>;
    getChatState: (chatId: string) => {
      running: unknown;
      decision: unknown;
    };
  };

  internal.config = {
    botToken: "test-token",
    ownerChatId: task.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  internal.callbacks = {
    runTelegramTaskAttempt: async (input: { taskId: string; userText: string }) => {
      if (input.taskId === task.id) {
        runCalls += 1;
      }
      assert.equal(input.userText, "继续处理这个后台任务");
      return {
        text: "任务已经继续完成",
        sessionId: "session_recovered_new",
        repairedIncompleteReply: false,
      };
    },
  } as never;
  internal.running = true;

  internal.recoverPersistedTelegramTasks();
  await internal.tickWorker();
  await delay(20);

  const updatedTask = getTelegramTaskById(task.id);
  const attempts = listTelegramAttemptsByTask(task.id);
  const recoveredOldAttempt = getTelegramAttemptById(oldAttempt.id);

  assert.equal(runCalls, 1);
  assert.equal(recoveredOldAttempt?.status, "pending");
  assert.equal(updatedTask?.status, "completed");
  assert.equal(updatedTask?.providerSessionId, "session_recovered_new");
  assert.equal(updatedTask?.activeAttemptId, null);
  assert.notEqual(updatedTask?.latestResultMessageId, null);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.status, "completed");
  assert.equal(attempts[1]?.providerSessionIdAfter, "session_recovered_new");
  assert.equal(internal.getChatState(task.chatId).running, null);
});

test("TelegramChannel worker fails a recovered task cleanly when the chat is no longer valid", async () => {
  const now = Date.now();
  const channel = new TelegramChannel({
    sendMessage: async () => {
      throw new Error("Bad Request: chat not found");
    },
    editMessageText: async () => true as never,
    deleteMessage: async () => true as never,
    sendChatAction: async () => true as never,
    commitReply: async () => {
      throw new Error("commit should not run");
    },
  });

  const task = createTask({
    chatId: `recover_invalid_${now}`,
    status: "queued",
    currentRevision: 1,
    currentPhase: "stable_running",
    providerSessionId: null,
  });
  createTelegramTask(task);
  createTelegramTaskInput(createTaskInput(task, 1, 1, "继续处理这个后台任务"));

  const internal = channel as unknown as {
    config: {
      botToken: string;
      ownerChatId: string;
      privateOnly: boolean;
      allowGroups: boolean;
      pollingTimeoutSeconds: number;
      finalReplyMode: "replace";
    } | null;
    callbacks: {
      runTelegramTaskAttempt: (input: {
        taskId: string;
        userText: string;
      }) => Promise<{
        text: string;
        sessionId: string | null;
        repairedIncompleteReply: boolean;
      }>;
    } | null;
    running: boolean;
    tickWorker: () => Promise<void>;
    getChatState: (chatId: string) => {
      running: unknown;
      decision: unknown;
    };
  };

  internal.config = {
    botToken: "test-token",
    ownerChatId: task.chatId,
    privateOnly: true,
    allowGroups: false,
    pollingTimeoutSeconds: 30,
    finalReplyMode: "replace",
  };
  internal.callbacks = {
    runTelegramTaskAttempt: async () => {
      throw new Error("provider should not run");
    },
  } as never;
  internal.running = true;

  await internal.tickWorker();
  await delay(20);

  const updatedTask = getTelegramTaskById(task.id);
  const attempts = listTelegramAttemptsByTask(task.id);

  assert.equal(updatedTask?.status, "failed");
  assert.equal(updatedTask?.activeAttemptId, null);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, "failed");
  assert.match(attempts[0]?.errorText || "", /chat not found/i);
  assert.equal(internal.getChatState(task.chatId).running, null);
});

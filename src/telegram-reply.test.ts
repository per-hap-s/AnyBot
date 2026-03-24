import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { parseReplyPayload } from "./message.js";
import {
  sanitizeTelegramReplyText,
  TELEGRAM_REPLY_REUSED_NOTIFICATION_TEXT,
} from "./telegram.js";

test("sanitizeTelegramReplyText removes engineering-style local reference blocks", () => {
  const text = sanitizeTelegramReplyText([
    "按现在代码，Telegram 状态链路可以分成两层看。",
    "",
    "参考代码：",
    "[telegram-status.ts](D:\\CodexProjects\\AnyBot\\src\\channels\\telegram-status.ts#L5)",
    "D:\\CodexProjects\\AnyBot\\src\\channels\\telegram.ts#L785",
    "",
    "结论是：最后会进入发送回复。",
  ].join("\n"));

  assert.match(text, /^简单说：Telegram 状态链路可以分成两层看。/u);
  assert.match(text, /结论是：最后会进入发送回复。/u);
  assert.doesNotMatch(text, /参考代码/u);
  assert.doesNotMatch(text, /D:\\CodexProjects\\AnyBot/u);
  assert.doesNotMatch(text, /\[telegram-status\.ts\]/u);
});

test("sanitizeTelegramReplyText keeps prose while replacing inline local links with short labels", () => {
  const text = sanitizeTelegramReplyText(
    "相关逻辑在 [telegram-status.ts](D:\\CodexProjects\\AnyBot\\src\\channels\\telegram-status.ts#L5) 里，结论不变。",
  );

  assert.match(text, /相关逻辑在 telegram-status\.ts 里/u);
  assert.match(text, /结论不变/u);
  assert.doesNotMatch(text, /D:\\CodexProjects\\AnyBot/u);
  assert.doesNotMatch(text, /\[telegram-status\.ts\]/u);
});

test("sanitizeTelegramReplyText rewrites engineering-heavy telegram prose into chat-style Chinese", () => {
  const text = sanitizeTelegramReplyText([
    "现在 `stop` 的实现很直接：它是 Telegram 专用命令，作用范围只限当前这个 chat。",
    "",
    "- 收到 `stop` 后，会先做命令归一化，所以群里发 `stop@BotUsername` 也支持，但发给别的 bot 的不会处理。",
    "- 然后它会把当前 chat 里所有活跃任务一起停掉，覆盖 `decision_pending / queued / running / waiting_next_attempt` 这几种状态。",
    "- 如果当前真有一个任务在跑，会立刻触发 `AbortController` 去中断 provider 执行，同时不会重置 session。",
  ].join("\n"));

  assert.match(text, /^简单说：/u);
  assert.match(text, /会停止当前聊天里的任务/u);
  assert.match(text, /不会清空上下文/u);
  assert.doesNotMatch(text, /decision_pending|queued|waiting_next_attempt|AbortController|provider/u);
  assert.doesNotMatch(text, /`decision_pending|`queued|`waiting_next_attempt|`AbortController|`provider/u);
  assert.ok((text.match(/\n-/g) || []).length <= 3);
});

test("sanitizeTelegramReplyText removes the last remaining internal terms from stop explanations", () => {
  const text = sanitizeTelegramReplyText([
    "简单说，/stop 现在是 Telegram 专用的“停当前聊天任务”命令。",
    "",
    "它收到后会把这个聊天里还活跃的任务都改成 cancelled（已取消），范围包括正在跑的、排队中的、等下一轮的、以及待你二选一决策的任务；如果有正在执行的任务，还会用 中止当前执行（中止控制器） 直接打断。",
    "",
    "- 它不会清空上下文，之后还能继续原来的会话。",
  ].join("\n"));

  assert.match(text, /已取消/u);
  assert.match(text, /等你确认怎么处理的任务/u);
  assert.match(text, /直接中止当前执行/u);
  assert.doesNotMatch(text, /cancelled|二选一决策|中止控制器/u);
  assert.match(text, /不会清空上下文/u);
});

test("telegram replace notification text stays lightweight", () => {
  assert.equal(TELEGRAM_REPLY_REUSED_NOTIFICATION_TEXT, "上方回复已更新");
});

test("telegram reply sanitization does not break file and image payload extraction", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "anybot-tg-reply-"));
  const filePath = path.join(tempDir, "notes.txt");
  const imagePath = path.join(tempDir, "preview.png");
  await writeFile(filePath, "hello");
  await writeFile(imagePath, "fake");

  const payload = parseReplyPayload([
    "先看结论。",
    `FILE: ${filePath}`,
    `![preview](${imagePath})`,
    "参考代码：",
    "[telegram.ts](D:\\CodexProjects\\AnyBot\\src\\telegram.ts#L583)",
  ].join("\n"), tempDir);

  assert.equal(payload.filePaths.length, 1);
  assert.equal(payload.imagePaths.length, 1);

  const text = sanitizeTelegramReplyText(payload.text);
  assert.match(text, /先看结论。/u);
  assert.doesNotMatch(text, /FILE:/u);
  assert.doesNotMatch(text, /preview\.png/u);
  assert.doesNotMatch(text, /D:\\CodexProjects\\AnyBot/u);
});

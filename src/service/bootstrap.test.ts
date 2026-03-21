import test from "node:test";
import assert from "node:assert/strict";

import { AnyBotService } from "./bootstrap.js";
import { ProviderTimeoutError, type ProviderRuntimeEvent, type RunOptions, type RunResult } from "../providers/index.js";
import { ProviderIncompleteReplyError } from "../reply-completion.js";
import * as db from "../web/db.js";

function createChatSession(source: string, chatId: string, sessionId: string | null = null): db.ChatSession {
  const session: db.ChatSession = {
    id: `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test Session",
    sessionId,
    source,
    chatId,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createSession(session);
  return session;
}

test("generateReply repairs placeholder lookup replies before persisting assistant output", async (t) => {
  const service = new AnyBotService();
  const provider = (service as unknown as { provider: { run: (opts: RunOptions) => Promise<RunResult> } }).provider;
  const chatId = `bootstrap-repair-${Date.now()}`;
  const source = "unknown";
  const session = createChatSession(source, chatId);
  const calls: Array<{ sessionId?: string; prompt: string }> = [];

  t.after(() => {
    db.deleteSession(session.id);
  });

  provider.run = async (opts: RunOptions) => {
    calls.push({
      sessionId: opts.sessionId,
      prompt: opts.prompt,
    });

    if (calls.length === 1) {
      return {
        text: "我先查一下公开信息，确认它到底是项目、产品还是网站。",
        sessionId: "thread_lookup_1",
      };
    }

    assert.equal(opts.sessionId, "thread_lookup_1");
    return {
      text: "Tokyo is currently about 14°C with light wind.",
      sessionId: null,
    };
  };

  const reply = await (service as unknown as {
    generateReply: (
      chatId: string,
      userText: string,
      imagePaths?: string[],
      source?: string,
    ) => Promise<string>;
  }).generateReply(
    chatId,
    "What is the current weather in Tokyo?",
    [],
    source,
  );

  assert.equal(reply, "Tokyo is currently about 14°C with light wind.");
  assert.equal(calls.length, 2);

  const stored = db.getSession(session.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.messages.map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "What is the current weather in Tokyo?" },
      { role: "assistant", content: "Tokyo is currently about 14°C with light wind." },
    ],
  );
  assert.equal(stored.sessionId, "thread_lookup_1");
});

test("generateReply does not reuse a stale resumed session for placeholder repair after fresh retry", async (t) => {
  const service = new AnyBotService();
  const provider = (service as unknown as { provider: { run: (opts: RunOptions) => Promise<RunResult> } }).provider;
  const chatId = `bootstrap-fresh-retry-${Date.now()}`;
  const source = "unknown";
  const session = createChatSession(source, chatId, "stale_thread");
  const calls: Array<{ sessionId?: string; prompt: string }> = [];

  t.after(() => {
    db.deleteSession(session.id);
  });

  provider.run = async (opts: RunOptions) => {
    calls.push({
      sessionId: opts.sessionId,
      prompt: opts.prompt,
    });

    if (calls.length === 1) {
      assert.equal(opts.sessionId, "stale_thread");
      throw new ProviderTimeoutError("idle", 120_000, false);
    }

    assert.equal(opts.sessionId, undefined);
    return {
      text: "我先查一下公开信息，确认它到底是项目、产品还是网站。",
      sessionId: null,
    };
  };

  await assert.rejects(
    (service as unknown as {
      generateReply: (
        chatId: string,
        userText: string,
        imagePaths?: string[],
        source?: string,
      ) => Promise<string>;
    }).generateReply(
      chatId,
      "What is the current weather in Tokyo?",
      [],
      source,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderIncompleteReplyError);
      return true;
    },
  );

  assert.equal(calls.length, 2);
  const stored = db.getSession(session.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.messages.map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "What is the current weather in Tokyo?" },
    ],
  );
  assert.equal(stored.sessionId, null);
});

test("generateReply accepts an explicit failure reason after repairing a vague lookup reply", async (t) => {
  const service = new AnyBotService();
  const provider = (service as unknown as { provider: { run: (opts: RunOptions) => Promise<RunResult> } }).provider;
  const chatId = `bootstrap-explicit-failure-${Date.now()}`;
  const source = "unknown";
  const session = createChatSession(source, chatId);
  let callCount = 0;

  t.after(() => {
    db.deleteSession(session.id);
  });

  provider.run = async (_opts: RunOptions) => {
    callCount += 1;

    if (callCount === 1) {
      return {
        text: "Not sure.",
        sessionId: "thread_lookup_failure_1",
      };
    }

    return {
      text: "Sorry, I can't access the weather source right now, so I can't confirm Tokyo weather.",
      sessionId: null,
    };
  };

  const reply = await (service as unknown as {
    generateReply: (
      chatId: string,
      userText: string,
      imagePaths?: string[],
      source?: string,
    ) => Promise<string>;
  }).generateReply(
    chatId,
    "What is the current weather in Tokyo?",
    [],
    source,
  );

  assert.equal(reply, "Sorry, I can't access the weather source right now, so I can't confirm Tokyo weather.");
  assert.equal(callCount, 2);

  const stored = db.getSession(session.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.messages.map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "What is the current weather in Tokyo?" },
      { role: "assistant", content: "Sorry, I can't access the weather source right now, so I can't confirm Tokyo weather." },
    ],
  );
  assert.equal(stored.sessionId, "thread_lookup_failure_1");
});

test("generateReply emits a repair-started event before continuing an incomplete lookup reply", async (t) => {
  const service = new AnyBotService();
  const provider = (service as unknown as { provider: { run: (opts: RunOptions) => Promise<RunResult> } }).provider;
  const chatId = `bootstrap-repair-event-${Date.now()}`;
  const source = "unknown";
  const session = createChatSession(source, chatId);
  const seenEvents: ProviderRuntimeEvent[] = [];
  let callCount = 0;

  t.after(() => {
    db.deleteSession(session.id);
  });

  provider.run = async (_opts: RunOptions) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        text: "I will check that.",
        sessionId: "thread_repair_event_1",
      };
    }

    return {
      text: "ClawHub is a project index site.",
      sessionId: null,
    };
  };

  const reply = await (service as unknown as {
    generateReply: (
      chatId: string,
      userText: string,
      imagePaths?: string[],
      source?: string,
      onEvent?: (event: ProviderRuntimeEvent) => void,
    ) => Promise<string>;
  }).generateReply(
    chatId,
    "What is ClawHub?",
    [],
    source,
    (event) => {
      seenEvents.push(event);
    },
  );

  assert.equal(reply, "ClawHub is a project index site.");
  assert.ok(seenEvents.some((event) => event.type === "reply.repair.started"));
});

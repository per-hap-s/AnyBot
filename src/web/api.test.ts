import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import express from "express";

import { chatRouter } from "./api.js";
import * as db from "./db.js";
import { initProvider, type RunOptions, type RunResult } from "../providers/index.js";

function createWebSession(sessionId: string | null = null): db.ChatSession {
  const session: db.ChatSession = {
    id: `web-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Web Session",
    sessionId,
    source: "web",
    chatId: null,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createSession(session);
  return session;
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(chatRouter({
    getStatus: () => ({
      ok: true,
      app: "anybot",
      pid: process.pid,
      webPort: 0,
      startedAt: Date.now(),
      version: "test",
      provider: "codex",
      currentModel: "gpt-5.3-codex",
      workdir: process.cwd(),
      sandbox: "read-only",
      channels: {
        registered: ["web"],
        running: ["web"],
        feishuEnabled: false,
        telegramEnabled: false,
      },
    }),
    requestShutdown: () => {},
    controlToken: "test-token",
  }));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("POST /sessions/:id/messages continues placeholder lookup replies before responding", async (t) => {
  const provider = initProvider();
  const session = createWebSession();
  const calls: Array<{ sessionId?: string; prompt: string }> = [];
  const { server, baseUrl } = await startTestServer();

  t.after(async () => {
    await stopTestServer(server);
    db.deleteSession(session.id);
  });

  (provider as unknown as { run: (opts: RunOptions) => Promise<RunResult> }).run = async (opts: RunOptions) => {
    calls.push({
      sessionId: opts.sessionId,
      prompt: opts.prompt,
    });

    if (calls.length === 1) {
      return {
        text: "I will check that.",
        sessionId: "thread_web_lookup_1",
      };
    }

    assert.equal(opts.sessionId, "thread_web_lookup_1");
    return {
      text: "Tokyo is currently about 14°C with light wind.",
      sessionId: null,
    };
  };

  const response = await fetch(`${baseUrl}/sessions/${session.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: "What is the current weather in Tokyo?",
    }),
  });
  const payload = await response.json() as { role: string; content: string };

  assert.equal(response.status, 200);
  assert.equal(payload.role, "assistant");
  assert.equal(payload.content, "Tokyo is currently about 14°C with light wind.");
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
  assert.equal(stored.sessionId, "thread_web_lookup_1");
});

test("POST /sessions/:id/messages/stream continues placeholder lookup replies before streaming the assistant event", async (t) => {
  const provider = initProvider();
  const session = createWebSession();
  const calls: Array<{ sessionId?: string; prompt: string }> = [];
  const { server, baseUrl } = await startTestServer();

  t.after(async () => {
    await stopTestServer(server);
    db.deleteSession(session.id);
  });

  (provider as unknown as { run: (opts: RunOptions) => Promise<RunResult> }).run = async (opts: RunOptions) => {
    calls.push({
      sessionId: opts.sessionId,
      prompt: opts.prompt,
    });

    if (calls.length === 1) {
      return {
        text: "I will check that.",
        sessionId: "thread_web_stream_1",
      };
    }

    assert.equal(opts.sessionId, "thread_web_stream_1");
    return {
      text: "Tokyo is currently about 14°C with light wind.",
      sessionId: null,
    };
  };

  const response = await fetch(`${baseUrl}/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: "What is the current weather in Tokyo?",
    }),
  });
  const body = await response.text();
  const events = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; content?: string });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(events.some((event) => event.type === "assistant" && event.content === "Tokyo is currently about 14°C with light wind."));
  assert.ok(events.some((event) => event.type === "done"));
  assert.ok(!events.some((event) => event.type === "assistant" && event.content === "I will check that."));

  const stored = db.getSession(session.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.messages.map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "What is the current weather in Tokyo?" },
      { role: "assistant", content: "Tokyo is currently about 14°C with light wind." },
    ],
  );
  assert.equal(stored.sessionId, "thread_web_stream_1");
});

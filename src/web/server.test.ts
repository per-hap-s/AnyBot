import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { createApp } from "./server.js";

async function startServer(authEnabled: boolean): Promise<{ server: Server; baseUrl: string }> {
  const app = createApp({
    getStatus: () => ({
      ok: true,
      app: "anybot",
      pid: process.pid,
      webHost: "127.0.0.1",
      webPort: 0,
      startedAt: Date.now(),
      version: "test",
      provider: "codex",
      currentModel: "gpt-5.4",
      workdir: process.cwd(),
      sandbox: "read-only",
      channels: {
        registered: [],
        running: [],
        feishuEnabled: false,
        telegramEnabled: false,
      },
    }),
    requestShutdown: () => {},
    controlToken: "test-token",
    webAuth: authEnabled
      ? { username: "alice", password: "secret", realm: "AnyBot" }
      : null,
  });

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

async function stopServer(server: Server): Promise<void> {
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

test("web app allows unauthenticated access when Basic Auth is disabled", async (t) => {
  const { server, baseUrl } = await startServer(false);
  t.after(async () => {
    await stopServer(server);
  });

  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 200);
});

test("web app challenges unauthenticated requests when Basic Auth is enabled", async (t) => {
  const { server, baseUrl } = await startServer(true);
  t.after(async () => {
    await stopServer(server);
  });

  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") || "", /^Basic /i);
});

test("web app accepts authenticated requests when Basic Auth is enabled", async (t) => {
  const { server, baseUrl } = await startServer(true);
  t.after(async () => {
    await stopServer(server);
  });

  const auth = Buffer.from("alice:secret", "utf8").toString("base64");
  const response = await fetch(`${baseUrl}/api/status`, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });
  assert.equal(response.status, 200);
});

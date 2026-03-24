import test from "node:test";
import assert from "node:assert/strict";

import { handleCommand } from "./commands.js";
import type { ChannelCallbacks } from "./types.js";

function createCallbacks(): ChannelCallbacks {
  return {
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
}

test("handleCommand shows /stop in Telegram help only", async () => {
  const telegram = await handleCommand("/help", "chat_1", "telegram", createCallbacks());
  const feishu = await handleCommand("/help", "chat_2", "feishu", createCallbacks());

  assert.match(telegram.reply || "", /\/stop/);
  assert.doesNotMatch(feishu.reply || "", /\/stop/);
});

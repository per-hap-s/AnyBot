import { readChannelsConfig } from "../channels/index.js";
import { buildPrivateMemoryScope } from "./store.js";
import type { MemoryScope } from "./types.js";

export const OWNER_PRIVATE_MEMORY_SCOPE = buildPrivateMemoryScope("owner");

export function resolveUnifiedPrivateMemoryScope(
  source: string,
  chatId: string,
): MemoryScope | null {
  if (source === "web") {
    return OWNER_PRIVATE_MEMORY_SCOPE;
  }

  const channelsConfig = readChannelsConfig();
  if (source === "telegram" && channelsConfig.telegram?.ownerChatId === chatId) {
    return OWNER_PRIVATE_MEMORY_SCOPE;
  }

  if (source === "feishu" && channelsConfig.feishu?.ownerChatId === chatId) {
    return OWNER_PRIVATE_MEMORY_SCOPE;
  }

  return null;
}

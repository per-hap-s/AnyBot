import type { ChannelCallbacks } from "./types.js";

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export async function handleCommand(
  userText: string,
  chatId: string,
  source: string,
  callbacks: ChannelCallbacks,
): Promise<CommandResult> {
  const trimmed = userText.trim();

  if (trimmed === "/new" || trimmed === "/reset" || trimmed === "/start") {
    callbacks.resetSession(chatId, source);
    return { handled: true, reply: "Started a new session." };
  }

  if (trimmed === "/help") {
    return { handled: true, reply: formatHelp(source) };
  }

  if (trimmed === "/model") {
    return { handled: true, reply: formatModelList(callbacks) };
  }

  if (trimmed.startsWith("/model ")) {
    const target = trimmed.slice("/model ".length).trim();
    if (!target) {
      return { handled: true, reply: formatModelList(callbacks) };
    }
    const result = callbacks.switchModel(target);
    return { handled: true, reply: result.message };
  }

  if (trimmed === "/memory") {
    return { handled: true, reply: callbacks.getMemoryStatus() };
  }

  if (trimmed === "/memories") {
    return { handled: true, reply: callbacks.listMemories() };
  }

  if (trimmed.startsWith("/remember ")) {
    const target = trimmed.slice("/remember ".length).trim();
    if (!target) {
      return { handled: true, reply: "Usage: /remember <durable fact>" };
    }
    const result = await callbacks.remember(target);
    return { handled: true, reply: result.message };
  }

  if (trimmed.startsWith("/profile ")) {
    const target = trimmed.slice("/profile ".length).trim();
    if (!target) {
      return { handled: true, reply: "Usage: /profile <durable user fact>" };
    }
    const result = await callbacks.updateProfile(target);
    return { handled: true, reply: result.message };
  }

  if (trimmed.startsWith("/forget ")) {
    const target = trimmed.slice("/forget ".length).trim();
    if (!target) {
      return { handled: true, reply: "Usage: /forget <memory text>" };
    }
    const result = await callbacks.forgetMemory(target);
    return { handled: true, reply: result.message };
  }

  if (trimmed === "/compress-memory") {
    const result = await callbacks.compressMemory();
    return { handled: true, reply: result.message };
  }

  return { handled: false };
}

function formatHelp(source: string): string {
  const lines = [
    "Available commands:",
    "",
    "/new - start a new session",
    "/model - list Codex models",
    "/model <name> - switch model",
    "/memory - show memory status",
    "/memories - list active canonical memories",
    "/remember <text> - save a durable memory note",
    "/profile <text> - save a durable profile fact",
    "/forget <text> - reject matching memories",
    "/compress-memory - deprecated legacy command",
  ];

  if (source === "telegram") {
    lines.push("/stop - stop all active tasks in this Telegram chat");
  }

  lines.push("/help - show this help");
  return lines.join("\n");
}

function formatModelList(callbacks: ChannelCallbacks): string {
  const models = callbacks.listModels();
  if (models.length === 0) {
    return "No Codex models are available.";
  }

  const lines = ["Available Codex models:"];
  for (const m of models) {
    const marker = m.isCurrent ? " (current)" : "";
    lines.push(`- ${m.id}${marker}`);
  }
  lines.push("", "Switch with: /model <name>");
  return lines.join("\n");
}

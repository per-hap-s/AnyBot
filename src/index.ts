import "dotenv/config";

import * as Lark from "@larksuiteoapi/node-sdk";
import { spawn } from "node:child_process";

type ChatRole = "user" | "assistant";

type ChatTurn = {
  role: ChatRole;
  content: string;
};

type TextMessageContent = {
  text?: string;
};

const sandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

type SandboxMode = (typeof sandboxModes)[number];

type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
};

const requiredEnv = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`缺少必填环境变量：${key}`);
  }
}

const appId = process.env.FEISHU_APP_ID as string;
const appSecret = process.env.FEISHU_APP_SECRET as string;
const groupChatMode = process.env.FEISHU_GROUP_CHAT_MODE || "mention";
const botOpenId = process.env.FEISHU_BOT_OPEN_ID;
const ackReaction = process.env.FEISHU_ACK_REACTION || "OK";
const codexBin = process.env.CODEX_BIN || "codex";
const codexSandboxRaw = process.env.CODEX_SANDBOX || "read-only";
const codexModel = process.env.CODEX_MODEL;
const codexWorkdir = process.env.CODEX_WORKDIR || process.cwd();
const systemPrompt =
  process.env.CODEX_SYSTEM_PROMPT ||
  "你是在飞书里回复的 Codex。默认简洁回答。";

if (!sandboxModes.includes(codexSandboxRaw as SandboxMode)) {
  throw new Error(
    `CODEX_SANDBOX 配置无效：${codexSandboxRaw}。可选值只有：${sandboxModes.join("、")}`,
  );
}

const codexSandbox = codexSandboxRaw as SandboxMode;

const larkClient = new Lark.Client({
  appId,
  appSecret,
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

const historyByChat = new Map<string, ChatTurn[]>();
const handledMessageIds = new Set<string>();
const MAX_HISTORY_TURNS = 12;

function parseIncomingText(content: string): string {
  try {
    const parsed = JSON.parse(content) as TextMessageContent;
    return (parsed.text || "").trim();
  } catch {
    return content.trim();
  }
}

function sanitizeUserText(text: string): string {
  return text.replace(/<at[^>]*>.*?<\/at>/g, "").trim();
}

function trimHistory(turns: ChatTurn[]): ChatTurn[] {
  return turns.slice(-MAX_HISTORY_TURNS);
}

function shouldReplyInGroup(
  mentions: Array<{
    id?: { open_id?: string };
  }> = [],
): boolean {
  if (groupChatMode === "all") {
    return true;
  }

  if (botOpenId) {
    return mentions.some((mention) => mention.id?.open_id === botOpenId);
  }

  return mentions.length > 0;
}

async function generateReply(chatId: string, userText: string): Promise<string> {
  const history = historyByChat.get(chatId) || [];
  const transcript = [...history, { role: "user" as const, content: userText }]
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    .join("\n\n");
  const prompt = `${systemPrompt}

Conversation so far:
${transcript}

Reply to the latest USER message only.`;

  const outputText = await runCodex(prompt);
  if (!outputText) {
    throw new Error("Codex 返回了空内容");
  }

  const nextHistory = trimHistory([
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: outputText },
  ]);
  historyByChat.set(chatId, nextHistory);

  return outputText;
}

async function runCodex(prompt: string): Promise<string> {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    codexWorkdir,
    "-s",
    codexSandbox,
  ];

  if (codexModel) {
    args.push("-m", codexModel);
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: codexWorkdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Codex 进程退出，状态码 ${code}：${stderr || stdout}`));
        return;
      }

      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as CodexJsonEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is CodexJsonEvent => Boolean(event))
        .filter(
          (event) =>
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            Boolean(event.item.text),
        )
        .map((event) => event.item?.text?.trim() || "")
        .filter(Boolean);

      const lastMessage = messages.at(-1);
      if (!lastMessage) {
        reject(new Error(`无法解析 Codex 输出：${stdout}`));
        return;
      }

      resolve(lastMessage);
    });
  });
}

async function sendText(chatId: string, text: string): Promise<void> {
  await larkClient.im.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

async function sendAckReaction(messageId: string): Promise<void> {
  if (!ackReaction) {
    return;
  }

  await larkClient.im.messageReaction.create({
    path: {
      message_id: messageId,
    },
    data: {
      reaction_type: {
        emoji_type: ackReaction,
      },
    },
  });
}

async function processMessage(message: {
  message_id: string;
  chat_id: string;
  content: string;
}): Promise<void> {
  const rawText = parseIncomingText(message.content);
  const userText = sanitizeUserText(rawText);

  if (!userText) {
    await sendText(message.chat_id, "请直接发送文字问题。");
    return;
  }

  try {
    await sendAckReaction(message.message_id);
  } catch (error) {
    console.error("发送已收到 reaction 失败", error);
  }

  try {
    const reply = await generateReply(message.chat_id, userText);
    await sendText(message.chat_id, reply);
  } catch (error) {
    console.error("处理消息失败", error);
    await sendText(message.chat_id, "处理消息时出错了，请稍后再试。");
  }
}

async function handleMessage(event: {
  sender: {
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      id?: { open_id?: string };
    }>;
  };
}): Promise<void> {
  const { sender, message } = event;

  if (sender.sender_type === "app") {
    return;
  }

  if (handledMessageIds.has(message.message_id)) {
    return;
  }
  handledMessageIds.add(message.message_id);

  if (message.message_type !== "text") {
    await sendText(message.chat_id, "目前只支持文本消息。");
    return;
  }

  if (
    message.chat_type === "group" ||
    message.chat_type === "group_chat"
  ) {
    if (!shouldReplyInGroup(message.mentions)) {
      return;
    }
  }

  void processMessage(message);
}

const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": handleMessage,
});

async function main(): Promise<void> {
  console.log("正在启动飞书机器人桥接服务...");
  await wsClient.start({
    eventDispatcher: dispatcher,
  });
  console.log("飞书机器人桥接服务已启动。");
}

main().catch((error) => {
  console.error("启动失败", error);
  process.exit(1);
});

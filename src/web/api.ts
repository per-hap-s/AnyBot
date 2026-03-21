import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import type { Request, Response } from "express";
import {
  getProvider,
  ProviderAbortedError,
  ProviderTimeoutError,
  shouldRetryFreshSessionAfterTimeout,
  type ProviderRuntimeEvent,
  type RunResult,
} from "../providers/index.js";
import { logger } from "../logger.js";
import * as db from "./db.js";
import {
  readModelConfig,
  getCurrentModel,
  setCurrentModel,
  getProviderTypes,
} from "./model-config.js";
import {
  readChannelsConfig,
  updateChannelConfig,
  channelManager,
  getRegisteredChannelTypes,
} from "../channels/index.js";
import { readProxyConfig, writeProxyConfig, getProxyUrl, type ProxyConfig } from "./proxy-config.js";
import { applyProxy } from "../proxy.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  buildFirstTurnPrompt,
  buildResumePrompt,
  generateId,
  generateTitle,
  getWorkdir,
  getSandbox,
} from "../shared.js";
import { ensureCompletedUserReply } from "../reply-completion.js";
import { CONTROL_TOKEN_HEADER } from "../control-token.js";
import type { ServiceStatusPayload } from "../service-status.js";
import {
  buildRelevantMemoryPromptSection,
  enqueueAutomaticMemoryJobs,
  isMemoryQuestion,
  retrieveRelevantCanonicalMemoriesDetailed,
  resolveUnifiedPrivateMemoryScope,
} from "../memory/index.js";

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
  ".ico",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
  ".avif",
]);

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

const UPLOAD_DIR = path.join(getWorkdir(), "tmp", "uploads");
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  // ignore
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    cb(null, `${base}-${unique}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

export interface ApiRouterOptions {
  getStatus: () => ServiceStatusPayload;
  requestShutdown: () => void;
  controlToken: string;
}

type AttachmentPayload = { path: string; name: string };

type PreparedMessageInput = {
  content: string;
  userText: string;
  imagePaths: string[];
  filePaths: AttachmentPayload[];
  metadata: string | null;
};

type StreamEvent =
  | { type: "started"; sessionId: string; title: string }
  | { type: "status"; phase: "preparing" | "running" | "finalizing"; message: string }
  | { type: "provider"; eventType: string; threadId?: string }
  | { type: "assistant"; content: string; title: string }
  | { type: "done"; title: string }
  | { type: "error"; error: string };

function isLoopbackAddress(value?: string): boolean {
  if (!value) return false;
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "::ffff:7f00:1"
  );
}

function prepareMessageInput(
  content?: string,
  attachments?: AttachmentPayload[],
): PreparedMessageInput {
  let userText = (content || "").trim();
  const imagePaths: string[] = [];
  const filePaths: AttachmentPayload[] = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (isImageFile(att.name)) {
        imagePaths.push(att.path);
      } else {
        filePaths.push(att);
      }
    }

    if (filePaths.length > 0) {
      const fileList = filePaths.map((file) => `- ${file.name}: ${file.path}`).join("\n");
      userText = `${userText}\n\nAttached files:\n${fileList}`;
    }

    if (imagePaths.length > 0) {
      const imageList = imagePaths.map((filePath) => `- ${path.basename(filePath)}: ${filePath}`).join("\n");
      userText = `${userText}\n\nAttached images:\n${imageList}`;
    }
  }

  const attachmentNames = (attachments || []).map((attachment) => attachment.name);
  const metadata = attachmentNames.length > 0
    ? JSON.stringify({ attachments: attachmentNames })
    : null;

  return {
    content: content?.trim() || "",
    userText,
    imagePaths,
    filePaths,
    metadata,
  };
}

function persistUserMessage(
  session: db.ChatSession,
  prepared: PreparedMessageInput,
): void {
  db.addMessage(session.id, "user", prepared.content || "[attachment]", prepared.metadata);

  if (session.messages.length <= 1) {
    session.title = generateTitle(prepared.content || "Attachment");
  }
}

async function buildSessionMemoryContext(
  session: db.ChatSession,
  userText: string,
): Promise<string> {
  const scope = resolveUnifiedPrivateMemoryScope("web", session.id);
  let memoryContext = "";

  if (scope) {
    try {
      const { hits, diagnostics } = await retrieveRelevantCanonicalMemoriesDetailed(scope, userText);
      logger.info("web.memory.retrieve.completed", {
        scope,
        sessionId: session.id,
        queryChars: userText.length,
        hitCount: hits.length,
        queryCategories: diagnostics.queryCategories,
        preliminaryHitCount: diagnostics.preliminaryHitCount,
        rerankCandidateCount: diagnostics.rerankCandidateCount,
        rerankUsed: diagnostics.rerankUsed,
        rerankFailed: diagnostics.rerankFailed,
        embeddingAvailable: diagnostics.embeddingAvailable,
        safeguardApplied: diagnostics.safeguardApplied,
        hits: hits.map((hit) => ({
          id: hit.id,
          category: hit.category,
          confidence: Number(hit.confidence.toFixed(4)),
          score: Number(hit.score.toFixed(4)),
        })),
      });
      memoryContext = buildRelevantMemoryPromptSection(hits, {
        isMemoryQuestion: isMemoryQuestion(userText),
      });
    } catch (error) {
      logger.warn("web.memory.retrieve.failed", {
        scope,
        sessionId: session.id,
        error,
      });
    }
  }

  return memoryContext;
}

async function buildSessionPrompts(
  session: db.ChatSession,
  userText: string,
): Promise<{ prompt: string; freshPrompt: string }> {
  const memoryContext = await buildSessionMemoryContext(session, userText);
  const freshPrompt = buildFirstTurnPrompt(userText, "web", memoryContext);
  const prompt = session.sessionId
    ? buildResumePrompt(userText, "web", memoryContext)
    : freshPrompt;

  return { prompt, freshPrompt };
}

function startNdjsonStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function writeStreamEvent(res: Response, event: StreamEvent): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`${JSON.stringify(event)}\n`);
}

function endStream(res: Response): void {
  if (!res.writableEnded) {
    res.end();
  }
}

export function chatRouter(options: ApiRouterOptions): Router {
  const router = Router();

  router.get("/status", (_req: Request, res: Response) => {
    res.json(options.getStatus());
  });

  router.post("/control/shutdown", (req: Request, res: Response) => {
    const remoteAddress = req.socket.remoteAddress || req.ip;
    const tokenHeader = req.headers[CONTROL_TOKEN_HEADER];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

    if (!isLoopbackAddress(remoteAddress)) {
      res.status(403).json({ error: "Shutdown is only allowed from localhost" });
      return;
    }

    if (token !== options.controlToken) {
      res.status(403).json({ error: "Invalid control token" });
      return;
    }

    res.json({ ok: true });
    setImmediate(() => {
      options.requestShutdown();
    });
  });

  router.get("/sessions", (_req: Request, res: Response) => {
    res.json(db.listSessions());
  });

  router.post("/sessions", (_req: Request, res: Response) => {
    const session: db.ChatSession = {
      id: generateId(),
      title: "New Chat",
      sessionId: null,
      source: "web",
      chatId: null,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.createSession(session);
    res.json({ id: session.id, title: session.title });
  });

  router.get("/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      id: session.id,
      title: session.title,
      messages: session.messages,
    });
  });

  router.delete("/sessions/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    db.deleteSession(id);
    res.json({ ok: true });
  });

  router.get("/model-config", (_req: Request, res: Response) => {
    try {
      res.json({
        ...readModelConfig(),
        providers: getProviderTypes(),
      });
    } catch {
      res.status(500).json({ error: "Failed to read model config" });
    }
  });

  router.put("/model-config", (req: Request, res: Response) => {
    const { modelId } = req.body as { modelId?: string };
    if (!modelId) {
      res.status(400).json({ error: "Missing modelId" });
      return;
    }

    try {
      const config = setCurrentModel(modelId);
      logger.info("model.switched", { modelId });
      res.json(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to switch model";
      res.status(400).json({ error: message });
    }
  });

  router.get("/channels", (_req: Request, res: Response) => {
    try {
      res.json({
        registered: getRegisteredChannelTypes(),
        config: readChannelsConfig(),
      });
    } catch {
      res.status(500).json({ error: "Failed to read channel config" });
    }
  });

  router.put("/channels/:type", (req: Request, res: Response) => {
    const channelType = req.params.type as string;
    if (!getRegisteredChannelTypes().includes(channelType)) {
      res.status(400).json({ error: `Unsupported channel type: ${channelType}` });
      return;
    }

    try {
      const config = updateChannelConfig(channelType, req.body);
      logger.info("channel.config.updated", { channelType });
      res.json(config);

      channelManager.restartChannel(channelType).catch((error) => {
        logger.error("channel.restart_after_save_failed", { channelType, error });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update channel config";
      res.status(400).json({ error: message });
    }
  });

  router.get("/proxy", (_req: Request, res: Response) => {
    try {
      res.json(readProxyConfig());
    } catch {
      res.status(500).json({ error: "Failed to read proxy config" });
    }
  });

  router.put("/proxy", (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<ProxyConfig>;
      const current = readProxyConfig();
      const config: ProxyConfig = {
        enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
        protocol: body.protocol === "socks5" ? "socks5" : "http",
        host: typeof body.host === "string" ? body.host.trim() : current.host,
        port: typeof body.port === "number" && body.port > 0 ? body.port : current.port,
        username: typeof body.username === "string" ? body.username : current.username,
        password: typeof body.password === "string" ? body.password : current.password,
      };
      writeProxyConfig(config);
      applyProxy(config);
      logger.info("proxy.config.updated", {
        enabled: config.enabled,
        protocol: config.protocol,
        host: config.host,
        port: config.port,
      });
      res.json(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update proxy config";
      res.status(400).json({ error: message });
    }
  });

  router.post("/proxy/test", async (req: Request, res: Response) => {
    const body = req.body as Partial<ProxyConfig> | undefined;
    const testConfig: ProxyConfig = {
      enabled: true,
      protocol: body?.protocol === "socks5" ? "socks5" : "http",
      host: (typeof body?.host === "string" && body.host.trim()) || "127.0.0.1",
      port: typeof body?.port === "number" && body.port > 0 ? body.port : 7890,
    };

    if (body?.username) testConfig.username = body.username;
    if (body?.password) testConfig.password = body.password;

    const proxyUrl = getProxyUrl(testConfig);
    if (!proxyUrl) {
      res.json({ ok: false, error: "Invalid proxy config" });
      return;
    }

    let agent: ProxyAgent | null = null;
    try {
      agent = new ProxyAgent(proxyUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const startedAt = Date.now();
      const response = await undiciFetch("https://www.google.com/generate_204", {
        dispatcher: agent,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      res.json({
        ok: response.ok || response.status === 204,
        latency: Date.now() - startedAt,
        status: response.status,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed";
      res.json({ ok: false, error: message });
    } finally {
      agent?.close();
    }
  });

  router.post("/send", async (req: Request, res: Response) => {
    const { channel, message } = req.body as {
      channel?: string;
      message?: string;
    };

    if (!channel || !getRegisteredChannelTypes().includes(channel)) {
      res.status(400).json({ error: "Unsupported channel" });
      return;
    }
    if (!message?.trim()) {
      res.status(400).json({ error: "Missing message" });
      return;
    }

    const ch = channelManager.getChannel(channel);
    if (!ch) {
      res.status(400).json({ error: `${channel} channel is not running` });
      return;
    }

    try {
      await ch.sendToOwner(message.trim());
      logger.info("api.send.success", { channel, messageChars: message.trim().length });
      res.json({ ok: true });
    } catch (error) {
      logger.error("api.send.failed", { channel, error });
      const responseMessage = error instanceof Error ? error.message : "Failed to send message";
      res.status(500).json({ error: responseMessage });
    }
  });

  router.post("/upload", upload.single("file"), (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const absPath = path.resolve(file.path);
    logger.info("web.upload.success", {
      name: file.originalname,
      path: absPath,
      size: file.size,
    });
    res.json({
      path: absPath,
      name: file.originalname,
      size: file.size,
      isImage: isImageFile(file.originalname),
    });
  });

  router.post("/sessions/:id/messages", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const { content, attachments } = req.body as {
      content?: string;
      attachments?: AttachmentPayload[];
    };
    if (!content?.trim() && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: "Message cannot be empty" });
      return;
    }

    const prepared = prepareMessageInput(content, attachments);
    persistUserMessage(session, prepared);
    const prompts = await buildSessionPrompts(session, prepared.userText);

    try {
      const provider = getProvider();
      logger.info("web.chat.start", {
        sessionId: session.id,
        providerSessionId: session.sessionId,
        provider: provider.type,
        userTextChars: prepared.userText.length,
        imageCount: prepared.imagePaths.length,
        fileCount: prepared.filePaths.length,
      });

      let result: RunResult;
      try {
        result = await provider.run({
          workdir: getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: prompts.prompt,
          imagePaths: prepared.imagePaths.length > 0 ? prepared.imagePaths : undefined,
          sessionId: session.sessionId || undefined,
        });
      } catch (error) {
        const shouldRetryFresh = Boolean(
          session.sessionId
          && shouldRetryFreshSessionAfterTimeout(error),
        );
        if (!shouldRetryFresh) {
          throw error;
        }

        logger.warn("web.chat.resume_timeout_retrying_fresh", {
          sessionId: session.id,
          providerSessionId: session.sessionId,
          provider: provider.type,
          timeoutKind: (error as ProviderTimeoutError).kind,
        });

        session.sessionId = null;
        db.updateSession({
          id,
          title: session.title,
          sessionId: null,
          updatedAt: Date.now(),
        });

        result = await provider.run({
          workdir: getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: prompts.freshPrompt,
          imagePaths: prepared.imagePaths.length > 0 ? prepared.imagePaths : undefined,
        });
      }

      const continuationSessionIdFallback = result.sessionId || session.sessionId || null;
      const completionOutcome = await ensureCompletedUserReply({
        userText: prepared.userText,
        result,
        sessionIdFallback: continuationSessionIdFallback,
        continueRun: async (continuationSessionId, continuationPrompt) => {
          logger.warn("web.chat.incomplete_reply_retrying", {
            sessionId: session.id,
            providerSessionId: continuationSessionId,
            provider: provider.type,
            replyPreview: result.text.slice(0, 120),
          });

          return provider.run({
            workdir: getWorkdir(),
            sandbox: getSandbox(),
            model: getCurrentModel(),
            prompt: continuationPrompt,
            sessionId: continuationSessionId,
          });
        },
      });
      result = completionOutcome.result;
      const providerSessionId = result.sessionId
        || (completionOutcome.repaired ? continuationSessionIdFallback : null)
        || session.sessionId
        || null;
      db.addMessage(id, "assistant", result.text);
      db.updateSession({
        id,
        title: session.title,
        sessionId: providerSessionId,
        updatedAt: Date.now(),
      });

      logger.info("web.chat.success", {
        sessionId: session.id,
        providerSessionId,
        provider: provider.type,
        replyChars: result.text.length,
        repairedIncompleteReply: completionOutcome.repaired,
      });

      if (resolveUnifiedPrivateMemoryScope("web", session.id)) {
        enqueueAutomaticMemoryJobs({
          source: "web",
          chatId: session.id,
          userText: prepared.userText,
          assistantText: result.text,
        });
      }

      res.json({
        role: "assistant",
        content: result.text,
        title: session.title,
      });
    } catch (error) {
      logger.error("web.chat.failed", {
        sessionId: session.id,
        error,
      });

      const message = error instanceof Error ? error.message : "Failed to handle message";
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions/:id/messages/stream", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = db.getSession(id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const { content, attachments } = req.body as {
      content?: string;
      attachments?: AttachmentPayload[];
    };
    if (!content?.trim() && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: "Message cannot be empty" });
      return;
    }

    const prepared = prepareMessageInput(content, attachments);
    persistUserMessage(session, prepared);
    const prompts = await buildSessionPrompts(session, prepared.userText);
    const provider = getProvider();
    const abortController = new AbortController();
    let completed = false;

    const abortStream = () => {
      if (!completed && !res.writableEnded) {
        abortController.abort();
      }
    };

    req.on("aborted", abortStream);
    res.on("close", abortStream);

    startNdjsonStream(res);
    writeStreamEvent(res, {
      type: "started",
      sessionId: session.id,
      title: session.title,
    });
    writeStreamEvent(res, {
      type: "status",
      phase: "preparing",
      message: "正在连接 Codex...",
    });

    try {
      logger.info("web.chat.stream.start", {
        sessionId: session.id,
        providerSessionId: session.sessionId,
        provider: provider.type,
        userTextChars: prepared.userText.length,
        imageCount: prepared.imagePaths.length,
        fileCount: prepared.filePaths.length,
      });

      let result: RunResult;
      const onProviderEvent = (event: ProviderRuntimeEvent) => {
        if (event.type === "thread.started") {
          writeStreamEvent(res, {
            type: "provider",
            eventType: event.type,
            threadId: event.threadId,
          });
          writeStreamEvent(res, {
            type: "status",
            phase: "running",
            message: "Codex 会话已建立，正在生成回复...",
          });
          return;
        }

        if (event.type === "turn.started") {
          writeStreamEvent(res, {
            type: "status",
            phase: "running",
            message: "正在生成回复...",
          });
          return;
        }

        if (event.type === "item.completed" && event.itemType === "agent_message") {
          writeStreamEvent(res, {
            type: "status",
            phase: "finalizing",
            message: "正在整理最终回复...",
          });
        }
      };

      try {
        result = await provider.run({
          workdir: getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: prompts.prompt,
          imagePaths: prepared.imagePaths.length > 0 ? prepared.imagePaths : undefined,
          sessionId: session.sessionId || undefined,
          signal: abortController.signal,
          onEvent: onProviderEvent,
        });
      } catch (error) {
        const shouldRetryFresh = Boolean(
          session.sessionId
          && !abortController.signal.aborted
          && shouldRetryFreshSessionAfterTimeout(error),
        );
        if (!shouldRetryFresh) {
          throw error;
        }

        logger.warn("web.chat.stream.resume_timeout_retrying_fresh", {
          sessionId: session.id,
          providerSessionId: session.sessionId,
          provider: provider.type,
          timeoutKind: (error as ProviderTimeoutError).kind,
        });
        writeStreamEvent(res, {
          type: "status",
          phase: "preparing",
          message: "续聊会话长时间无进展，正在重试新会话...",
        });

        session.sessionId = null;
        db.updateSession({
          id,
          title: session.title,
          sessionId: null,
          updatedAt: Date.now(),
        });

        result = await provider.run({
          workdir: getWorkdir(),
          sandbox: getSandbox(),
          model: getCurrentModel(),
          prompt: prompts.freshPrompt,
          imagePaths: prepared.imagePaths.length > 0 ? prepared.imagePaths : undefined,
          signal: abortController.signal,
          onEvent: onProviderEvent,
        });
      }

      const continuationSessionIdFallback = result.sessionId || session.sessionId || null;
      const completionOutcome = await ensureCompletedUserReply({
        userText: prepared.userText,
        result,
        sessionIdFallback: continuationSessionIdFallback,
        continueRun: async (continuationSessionId, continuationPrompt) => {
          logger.warn("web.chat.stream.incomplete_reply_retrying", {
            sessionId: session.id,
            providerSessionId: continuationSessionId,
            provider: provider.type,
            replyPreview: result.text.slice(0, 120),
          });

          return provider.run({
            workdir: getWorkdir(),
            sandbox: getSandbox(),
            model: getCurrentModel(),
            prompt: continuationPrompt,
            sessionId: continuationSessionId,
            signal: abortController.signal,
            onEvent: onProviderEvent,
          });
        },
      });
      result = completionOutcome.result;
      const providerSessionId = result.sessionId
        || (completionOutcome.repaired ? continuationSessionIdFallback : null)
        || session.sessionId
        || null;
      db.addMessage(id, "assistant", result.text);
      db.updateSession({
        id,
        title: session.title,
        sessionId: providerSessionId,
        updatedAt: Date.now(),
      });

      logger.info("web.chat.stream.success", {
        sessionId: session.id,
        providerSessionId,
        provider: provider.type,
        replyChars: result.text.length,
        repairedIncompleteReply: completionOutcome.repaired,
      });

      if (resolveUnifiedPrivateMemoryScope("web", session.id)) {
        enqueueAutomaticMemoryJobs({
          source: "web",
          chatId: session.id,
          userText: prepared.userText,
          assistantText: result.text,
        });
      }

      writeStreamEvent(res, {
        type: "assistant",
        content: result.text,
        title: session.title,
      });
      writeStreamEvent(res, {
        type: "done",
        title: session.title,
      });
      completed = true;
      endStream(res);
    } catch (error) {
      if (error instanceof ProviderAbortedError && abortController.signal.aborted) {
        completed = true;
        endStream(res);
        return;
      }

      logger.error("web.chat.stream.failed", {
        sessionId: session.id,
        error,
      });

      const message = error instanceof Error ? error.message : "Failed to handle message";
      writeStreamEvent(res, { type: "error", error: message });
      completed = true;
      endStream(res);
    }
  });

  return router;
}

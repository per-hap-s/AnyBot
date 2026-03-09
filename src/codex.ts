import { spawn } from "node:child_process";

import type { SandboxMode, CodexJsonEvent } from "./types.js";
import { logger } from "./logger.js";

export class CodexTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Codex 执行超时（${Math.round(timeoutMs / 1000)}s）`);
    this.name = "CodexTimeoutError";
  }
}

export class CodexProcessError extends Error {
  constructor(exitCode: number | null, output: string) {
    const code = exitCode ?? "unknown";
    const preview = output.slice(0, 300);
    super(`Codex 进程异常退出（状态码 ${code}）：${preview}`);
    this.name = "CodexProcessError";
  }
}

export class CodexEmptyOutputError extends Error {
  constructor() {
    super("Codex 返回了空内容");
    this.name = "CodexEmptyOutputError";
  }
}

export class CodexParseError extends Error {
  constructor(stdout: string) {
    const preview = stdout.slice(0, 300);
    super(`无法从 Codex 输出中解析有效消息：${preview}`);
    this.name = "CodexParseError";
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type RunCodexOptions = {
  bin: string;
  workdir: string;
  sandbox: SandboxMode;
  model?: string;
  prompt: string;
  imagePaths?: string[];
  sessionId?: string;
  timeoutMs?: number;
};

export type RunCodexResult = {
  text: string;
  sessionId: string | null;
};

export async function runCodex(opts: RunCodexOptions): Promise<RunCodexResult> {
  const {
    bin,
    workdir,
    sandbox,
    model,
    prompt,
    imagePaths = [],
    sessionId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;
  const startedAt = Date.now();

  const args: string[] = sessionId
    ? [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
    ]
    : [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      workdir,
      "-s",
      sandbox,
    ];

  if (sessionId && sandbox === "danger-full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (model) {
    args.push("-m", model);
  }

  for (const imagePath of imagePaths) {
    args.push("-i", imagePath);
  }

  if (sessionId) {
    args.push(sessionId);
  }
  args.push("-");

  logger.info("codex.exec.start", {
    bin,
    workdir,
    sandbox,
    model: model || null,
    sessionId: sessionId || null,
    imageCount: imagePaths.length,
    promptChars: prompt.length,
    timeoutMs,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workdir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let startedThreadId: string | null = null;

    const killProcessGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const timer = setTimeout(() => {
      killed = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        if (!child.killed) killProcessGroup("SIGKILL");
      }, 3000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("error", (error) => {
      clearTimeout(timer);
      logger.error("codex.exec.spawn_error", {
        workdir,
        sandbox,
        durationMs: Date.now() - startedAt,
        error,
      });
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (killed) {
        logger.warn("codex.exec.timeout", {
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
        });
        reject(new CodexTimeoutError(timeoutMs));
        return;
      }

      if (code !== 0) {
        logger.error("codex.exec.non_zero_exit", {
          code,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stderrPreview: stderr.slice(0, 400),
          stdoutPreview: stdout.slice(0, 400),
        });
        reject(new CodexProcessError(code, stderr || stdout));
        return;
      }

      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const messages = lines
        .map((line) => {
          try {
            const event = JSON.parse(line) as CodexJsonEvent;
            if (event.type === "thread.started" && event.thread_id) {
              startedThreadId = event.thread_id;
            }
            return event;
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
        logger.error("codex.exec.parse_error", {
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          stdoutChars: stdout.length,
          stdoutPreview: stdout.slice(0, 400),
        });
        reject(new CodexParseError(stdout));
        return;
      }

      logger.info("codex.exec.success", {
        workdir,
        sandbox,
        durationMs: Date.now() - startedAt,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        messageCount: messages.length,
        replyChars: lastMessage.length,
        sessionId: startedThreadId || sessionId || null,
      });
      resolve({
        text: lastMessage,
        sessionId: startedThreadId || sessionId || null,
      });
    });
  });
}

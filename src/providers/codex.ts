import { spawn } from "node:child_process";
import type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
  ProviderRuntimeEvent,
} from "./types.js";
import type { CodexJsonEvent } from "../types.js";
import { logger } from "../logger.js";

export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider execution timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderProcessError extends Error {
  constructor(exitCode: number | null, output: string) {
    const code = exitCode ?? "unknown";
    const preview = output.slice(0, 300);
    super(`Provider exited with code ${code}: ${preview}`);
    this.name = "ProviderProcessError";
  }
}

export class ProviderEmptyOutputError extends Error {
  constructor() {
    super("Provider returned empty output");
    this.name = "ProviderEmptyOutputError";
  }
}

export class ProviderParseError extends Error {
  constructor(stdout: string) {
    const preview = stdout.slice(0, 300);
    super(`Failed to parse provider output: ${preview}`);
    this.name = "ProviderParseError";
  }
}

export class ProviderAbortedError extends Error {
  constructor() {
    super("Provider execution was aborted");
    this.name = "ProviderAbortedError";
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class CodexProvider implements IProvider {
  readonly type = "codex";
  readonly displayName = "Codex CLI";
  readonly capabilities: ProviderCapabilities = {
    sessionResume: true,
    imageInput: true,
    sandbox: true,
  };

  private readonly bin: string;

  constructor(opts?: { bin?: string }) {
    this.bin = opts?.bin ?? "codex";
  }

  listModels(): ProviderModel[] {
    return [
      { id: "gpt-5.4", name: "GPT-5.4", description: "Latest general model" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Default coding model" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "Stable coding model" },
    ];
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const {
      workdir,
      prompt,
      model,
      imagePaths = [],
      sessionId,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal,
      onEvent,
    } = opts;
    const sandbox = opts.sandbox ?? process.env.CODEX_SANDBOX ?? "read-only";
    const startedAt = Date.now();
    const canUseDetachedGroup = process.platform !== "win32";

    const args: string[] = sessionId
      ? ["exec", "resume", "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", workdir, "-s", sandbox];

    if (sessionId) {
      if (sandbox === "danger-full-access") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (sandbox === "workspace-write") {
        args.push("--full-auto");
      }
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

    logger.info("provider.exec.start", {
      provider: this.type,
      bin: this.bin,
      workdir,
      sandbox,
      model: model || null,
      sessionId: sessionId || null,
      imageCount: imagePaths.length,
      promptChars: prompt.length,
      timeoutMs,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: workdir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: canUseDetachedGroup,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBuffer = "";
      let killed = false;
      let aborted = false;
      let startedThreadId: string | null = null;
      let lastMessage: string | null = null;

      const emitEvent = (event: ProviderRuntimeEvent) => {
        try {
          onEvent?.(event);
        } catch (error) {
          logger.warn("provider.exec.event_handler_failed", {
            provider: this.type,
            error,
          });
        }
      };

      const terminateChild = (signal: NodeJS.Signals) => {
        if (canUseDetachedGroup && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // fallback below
          }
        }

        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      };

      const handleStdoutLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const event = JSON.parse(trimmed) as CodexJsonEvent;
          if (event.type === "thread.started" && event.thread_id) {
            startedThreadId = event.thread_id;
          }

          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            event.item.text?.trim()
          ) {
            lastMessage = event.item.text.trim();
          }

          emitEvent({
            type: event.type || "unknown",
            threadId: event.thread_id,
            itemType: event.item?.type,
            text: event.item?.text,
          });
        } catch {
          // Ignore non-JSON stdout lines.
        }
      };

      const flushStdoutBuffer = () => {
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          handleStdoutLine(line);
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      };

      const timer = setTimeout(() => {
        killed = true;
        terminateChild("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            terminateChild("SIGKILL");
          }
        }, 3000);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        stdoutBuffer += text;
        flushStdoutBuffer();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.stdin.write(prompt);
      child.stdin.end();

      const abortHandler = () => {
        aborted = true;
        terminateChild("SIGTERM");
      };

      if (signal) {
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      child.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        logger.error("provider.exec.spawn_error", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          error,
        });

        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              "Failed to start Codex CLI. Set CODEX_BIN to the full executable path if it is not available in PATH.",
            ),
          );
          return;
        }

        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        if (stdoutBuffer.trim()) {
          handleStdoutLine(stdoutBuffer);
          stdoutBuffer = "";
        }

        if (killed) {
          logger.warn("provider.exec.timeout", {
            provider: this.type,
            workdir,
            sandbox,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
          });
          reject(new ProviderTimeoutError(timeoutMs));
          return;
        }

        if (aborted) {
          logger.info("provider.exec.aborted", {
            provider: this.type,
            workdir,
            sandbox,
            durationMs: Date.now() - startedAt,
          });
          reject(new ProviderAbortedError());
          return;
        }

        if (code !== 0) {
          logger.error("provider.exec.non_zero_exit", {
            provider: this.type,
            code,
            workdir,
            sandbox,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            stderrPreview: stderr.slice(0, 400),
            stdoutPreview: stdout.slice(0, 400),
          });
          reject(new ProviderProcessError(code, stderr || stdout));
          return;
        }

        if (!lastMessage) {
          logger.error("provider.exec.parse_error", {
            provider: this.type,
            workdir,
            sandbox,
            durationMs: Date.now() - startedAt,
            stdoutChars: stdout.length,
            stdoutPreview: stdout.slice(0, 400),
          });
          reject(new ProviderParseError(stdout));
          return;
        }

        logger.info("provider.exec.success", {
          provider: this.type,
          workdir,
          sandbox,
          durationMs: Date.now() - startedAt,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
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
}

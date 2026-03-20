import { spawn } from "node:child_process";
import type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
  ProviderRuntimeEvent,
  ProviderTimeoutKind,
} from "./types.js";
import type { CodexJsonEvent } from "../types.js";
import { logger } from "../logger.js";
import {
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  DEFAULT_PROVIDER_MAX_RUNTIME_MS,
  getProviderLongStepKey,
  isProviderProgressEvent,
  shouldTriggerProviderIdleTimeout,
  normalizeProviderRuntimeEvent,
} from "./runtime.js";

export class ProviderTimeoutError extends Error {
  readonly kind: ProviderTimeoutKind;
  readonly timeoutMs: number;
  readonly hadProgress: boolean;

  constructor(kind: ProviderTimeoutKind, timeoutMs: number, hadProgress: boolean) {
    const label = kind === "idle" ? "stalled with no progress" : "reached max runtime";
    super(`Provider execution ${label} after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "ProviderTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
    this.hadProgress = hadProgress;
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

export function shouldRetryFreshSessionAfterTimeout(error: unknown): error is ProviderTimeoutError {
  return error instanceof ProviderTimeoutError && error.kind === "idle" && !error.hadProgress;
}

export const PROVIDER_FORCE_KILL_DELAY_MS = 3_000;

export function scheduleProviderForceKill(
  isClosed: () => boolean,
  terminate: (signal: NodeJS.Signals) => void,
  delayMs: number = PROVIDER_FORCE_KILL_DELAY_MS,
): NodeJS.Timeout {
  return setTimeout(() => {
    if (!isClosed()) {
      terminate("SIGKILL");
    }
  }, delayMs);
}

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
      timeoutMs,
      idleTimeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
      maxRuntimeMs = timeoutMs ?? DEFAULT_PROVIDER_MAX_RUNTIME_MS,
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
      idleTimeoutMs,
      maxRuntimeMs,
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
      let aborted = false;
      let closed = false;
      let startedThreadId: string | null = null;
      let lastMessage: string | null = null;
      let timeoutState: { kind: ProviderTimeoutKind; timeoutMs: number; hadProgress: boolean } | null = null;
      let sawProgress = false;
      let lastProgressAt = startedAt;
      const activeLongStepKeys = new Set<string>();
      let idleTimer: NodeJS.Timeout | null = null;
      let maxRuntimeTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;

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

      const clearTimers = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (maxRuntimeTimer) {
          clearTimeout(maxRuntimeTimer);
          maxRuntimeTimer = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };

      const scheduleForceKill = () => {
        if (forceKillTimer || closed) {
          return;
        }
        forceKillTimer = scheduleProviderForceKill(
          () => closed,
          terminateChild,
        );
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

      const triggerTimeout = (kind: ProviderTimeoutKind, limitMs: number) => {
        if (timeoutState || aborted) {
          return;
        }
        timeoutState = {
          kind,
          timeoutMs: limitMs,
          hadProgress: sawProgress,
        };
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (maxRuntimeTimer) {
          clearTimeout(maxRuntimeTimer);
          maxRuntimeTimer = null;
        }
        terminateChild("SIGTERM");
        scheduleForceKill();
      };

      const trackLongStep = (event: ProviderRuntimeEvent) => {
        const longStepKey = getProviderLongStepKey(event);
        if (!longStepKey) {
          if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") {
            activeLongStepKeys.clear();
          }
          return;
        }

        if (event.type === "item.started") {
          activeLongStepKeys.add(longStepKey);
          return;
        }

        if (event.type === "item.completed") {
          activeLongStepKeys.delete(longStepKey);
        }
      };

      const markProgress = () => {
        sawProgress = true;
        lastProgressAt = Date.now();
        resetIdleTimer();
      };

      const scheduleIdleCheck = (delayMs: number) => {
        idleTimer = setTimeout(checkIdleTimer, delayMs);
      };

      const checkIdleTimer = () => {
        const now = Date.now();
        if (shouldTriggerProviderIdleTimeout(
          lastProgressAt,
          activeLongStepKeys.size,
          now,
          idleTimeoutMs,
        )) {
          triggerTimeout("idle", idleTimeoutMs);
          return;
        }

        if (timeoutState || aborted || closed) {
          return;
        }

        const elapsed = now - lastProgressAt;
        const nextDelay = activeLongStepKeys.size > 0
          ? idleTimeoutMs
          : Math.max(1, idleTimeoutMs - elapsed);
        scheduleIdleCheck(nextDelay);
      };

      const resetIdleTimer = () => {
        if (idleTimeoutMs <= 0 || timeoutState || aborted || closed) {
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        scheduleIdleCheck(idleTimeoutMs);
      };

      const handleStdoutLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const event = JSON.parse(trimmed) as CodexJsonEvent;
          const normalizedEvent = normalizeProviderRuntimeEvent(event);
          if (normalizedEvent.type === "thread.started" && normalizedEvent.threadId) {
            startedThreadId = normalizedEvent.threadId;
          }

          if (
            normalizedEvent.type === "item.completed" &&
            normalizedEvent.itemType === "agent_message" &&
            normalizedEvent.text
          ) {
            lastMessage = normalizedEvent.text;
          }

          trackLongStep(normalizedEvent);
          if (isProviderProgressEvent(normalizedEvent)) {
            markProgress();
          }

          emitEvent(normalizedEvent);
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

      if (maxRuntimeMs > 0) {
        maxRuntimeTimer = setTimeout(() => {
          triggerTimeout("max_runtime", maxRuntimeMs);
        }, maxRuntimeMs);
      }
      resetIdleTimer();

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
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (maxRuntimeTimer) {
          clearTimeout(maxRuntimeTimer);
          maxRuntimeTimer = null;
        }
        terminateChild("SIGTERM");
        scheduleForceKill();
      };

      if (signal) {
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      child.on("error", (error) => {
        closed = true;
        activeLongStepKeys.clear();
        clearTimers();
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
        closed = true;
        activeLongStepKeys.clear();
        clearTimers();
        signal?.removeEventListener("abort", abortHandler);
        if (stdoutBuffer.trim()) {
          handleStdoutLine(stdoutBuffer);
          stdoutBuffer = "";
        }

        if (timeoutState) {
          logger.warn("provider.exec.timeout", {
            provider: this.type,
            workdir,
            sandbox,
            durationMs: Date.now() - startedAt,
            timeoutKind: timeoutState.kind,
            timeoutMs: timeoutState.timeoutMs,
            hadProgress: timeoutState.hadProgress,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
          });
          reject(new ProviderTimeoutError(
            timeoutState.kind,
            timeoutState.timeoutMs,
            timeoutState.hadProgress,
          ));
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

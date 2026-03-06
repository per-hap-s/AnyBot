type LogLevel = "debug" | "info" | "warn" | "error";
type RawLogString = {
  __rawLogString: true;
  value: string;
};

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = parseLogLevel(process.env.LOG_LEVEL);
const logContentEnabled = parseBooleanFlag(process.env.LOG_INCLUDE_CONTENT);
const logPromptEnabled = parseBooleanFlag(process.env.LOG_INCLUDE_PROMPT);
const logToStdout = resolveLogToStdout(process.env.LOG_TO_STDOUT);
const logDir = path.resolve(process.env.LOG_DIR || ".run");
const logBaseName = process.env.LOG_BASENAME || "bot.log";

function parseLogLevel(value?: string): LogLevel {
  switch ((value || "").trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value!.trim().toLowerCase() as LogLevel;
    default:
      return "info";
  }
}

function parseBooleanFlag(value?: string): boolean {
  switch ((value || "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

function resolveLogToStdout(value?: string): boolean {
  if (value !== undefined) {
    return parseBooleanFlag(value);
  }

  return Boolean(process.stdout.isTTY);
}

function shouldLog(level: LogLevel): boolean {
  return levelWeight[level] >= levelWeight[configuredLevel];
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function sanitizeValue(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__rawLogString" in value &&
    value.__rawLogString === true &&
    "value" in value &&
    typeof value.value === "string"
  ) {
    return value.value;
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 1000) {
      return `${value.slice(0, 1000)}...<truncated>`;
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, sanitizeValue(nested)]),
  );
}

export function rawLogString(value: string): RawLogString {
  return {
    __rawLogString: true,
    value,
  };
}

export function includeContentInLogs(): boolean {
  return logContentEnabled;
}

export function includePromptInLogs(): boolean {
  return logPromptEnabled;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? { ctx: sanitizeValue(context) } : {}),
  };

  const line = JSON.stringify(payload);
  writeLogFile(line);

  if (!logToStdout) {
    return;
  }

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function writeLogFile(line: string): void {
  mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, buildLogFileName(new Date()));
  appendFileSync(filePath, `${line}\n`, "utf8");
}

function buildLogFileName(date: Date): string {
  const bucketDate = new Date(date.getTime());
  bucketDate.setSeconds(0, 0);
  bucketDate.setMinutes(Math.floor(bucketDate.getMinutes() / 10) * 10);

  const year = bucketDate.getFullYear();
  const month = String(bucketDate.getMonth() + 1).padStart(2, "0");
  const day = String(bucketDate.getDate()).padStart(2, "0");
  const hour = String(bucketDate.getHours()).padStart(2, "0");
  const minute = String(bucketDate.getMinutes()).padStart(2, "0");

  return `${logBaseName}.${year}${month}${day}-${hour}${minute}`;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>) {
    emit("debug", message, context);
  },
  info(message: string, context?: Record<string, unknown>) {
    emit("info", message, context);
  },
  warn(message: string, context?: Record<string, unknown>) {
    emit("warn", message, context);
  },
  error(message: string, context?: Record<string, unknown>) {
    emit("error", message, context);
  },
};

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getControlTokenPath } from "./runtime-paths.js";

export const CONTROL_TOKEN_HEADER = "x-anybot-control-token";

type ControlTokenFile = {
  token: string;
  updatedAt: number;
  pid: number;
};

export function readControlToken(baseDir?: string): string | null {
  const tokenPath = getControlTokenPath(baseDir);
  if (!existsSync(tokenPath)) {
    return null;
  }

  try {
    const raw = readFileSync(tokenPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ControlTokenFile>;
    return typeof parsed.token === "string" && parsed.token.trim()
      ? parsed.token.trim()
      : null;
  } catch {
    return null;
  }
}

export function ensureControlToken(baseDir?: string): string {
  const tokenPath = getControlTokenPath(baseDir);
  const existing = process.env.ANYBOT_CONTROL_TOKEN?.trim() || readControlToken(baseDir);
  const token = existing || randomUUID();

  mkdirSync(path.dirname(tokenPath), { recursive: true });
  const payload: ControlTokenFile = {
    token,
    updatedAt: Date.now(),
    pid: process.pid,
  };
  writeFileSync(tokenPath, JSON.stringify(payload, null, 2), "utf-8");
  return token;
}

import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler, Response } from "express";

export interface WebAuthConfig {
  username: string;
  password: string;
  realm?: string;
}

function toComparableBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function constantTimeMatch(actual: string, expected: string): boolean {
  const actualBuffer = toComparableBuffer(actual);
  const expectedBuffer = toComparableBuffer(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function unauthorized(res: Response, realm: string): void {
  res.setHeader("WWW-Authenticate", `Basic realm="${realm.replace(/"/g, "")}"`);
  res.status(401).send("Authentication required");
}

function parseBasicAuthHeader(req: Request): { username: string; password: string } | null {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, encoded] = header.split(" ", 2);
  if (!scheme || !encoded || scheme.toLowerCase() !== "basic") {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

export function readWebAuthConfig(env: NodeJS.ProcessEnv = process.env): WebAuthConfig | null {
  const username = env.ANYBOT_WEB_BASIC_AUTH_USER?.trim();
  const password = env.ANYBOT_WEB_BASIC_AUTH_PASSWORD?.trim();
  if (!username || !password) {
    return null;
  }

  return {
    username,
    password,
    realm: env.ANYBOT_WEB_BASIC_AUTH_REALM?.trim() || "AnyBot",
  };
}

export function createBasicAuthMiddleware(config: WebAuthConfig | null): RequestHandler {
  if (!config) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const credentials = parseBasicAuthHeader(req);
    if (!credentials) {
      unauthorized(res, config.realm || "AnyBot");
      return;
    }

    if (
      !constantTimeMatch(credentials.username, config.username)
      || !constantTimeMatch(credentials.password, config.password)
    ) {
      unauthorized(res, config.realm || "AnyBot");
      return;
    }

    next();
  };
}

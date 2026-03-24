import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatRouter, type ApiRouterOptions } from "./api.js";
import { createBasicAuthMiddleware, type WebAuthConfig } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CreateAppOptions extends ApiRouterOptions {
  webAuth?: WebAuthConfig | null;
}

export function createApp(options: CreateAppOptions): express.Application {
  const app = express();

  app.use(express.json());
  app.use(createBasicAuthMiddleware(options.webAuth || null));
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/api", chatRouter(options));

  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatRouter, type ApiRouterOptions } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(options: ApiRouterOptions): express.Application {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/api", chatRouter(options));

  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

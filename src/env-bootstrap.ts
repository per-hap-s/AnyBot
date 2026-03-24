import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

function resolveAppRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, ".."),
    path.resolve(here, "../.."),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return process.cwd();
}

const appRoot = resolveAppRoot();
const envPath = path.join(appRoot, ".env");

config({
  path: envPath,
  override: false,
});

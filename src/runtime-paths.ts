import path from "node:path";

export function getRuntimeRoot(baseDir: string = process.cwd()): string {
  return path.resolve(process.env.ANYBOT_RUNTIME_ROOT || baseDir);
}

export function getDataDir(baseDir: string = process.cwd()): string {
  return path.resolve(
    process.env.DATA_DIR ||
      process.env.CODEX_DATA_DIR ||
      path.join(getRuntimeRoot(baseDir), ".data"),
  );
}

export function getRunDir(baseDir: string = process.cwd()): string {
  return path.resolve(process.env.LOG_DIR || path.join(getRuntimeRoot(baseDir), ".run"));
}

export function getControlTokenPath(baseDir: string = process.cwd()): string {
  return path.join(getRunDir(baseDir), "control-token.json");
}

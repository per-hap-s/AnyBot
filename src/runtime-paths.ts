import { tmpdir } from "node:os";
import path from "node:path";

type RuntimePathOptions = {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  pid?: number;
};

export function isNodeTestProcess(execArgv: readonly string[] = process.execArgv): boolean {
  return execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-"));
}

function getAutoTestRuntimeRoot(baseDir: string, pid: number): string {
  return path.join(tmpdir(), "anybot-node-test", path.basename(path.resolve(baseDir)), `pid-${pid}`);
}

export function getRuntimeRoot(
  baseDir: string = process.cwd(),
  options: RuntimePathOptions = {},
): string {
  const env = options.env ?? process.env;
  const execArgv = options.execArgv ?? process.execArgv;
  const pid = options.pid ?? process.pid;

  if (env.ANYBOT_RUNTIME_ROOT) {
    return path.resolve(env.ANYBOT_RUNTIME_ROOT);
  }

  if (isNodeTestProcess(execArgv)) {
    return path.resolve(getAutoTestRuntimeRoot(baseDir, pid));
  }

  return path.resolve(baseDir);
}

export function getDataDir(
  baseDir: string = process.cwd(),
  options: RuntimePathOptions = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(
    env.DATA_DIR ||
      env.CODEX_DATA_DIR ||
      path.join(getRuntimeRoot(baseDir, options), ".data"),
  );
}

export function getRunDir(
  baseDir: string = process.cwd(),
  options: RuntimePathOptions = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(env.LOG_DIR || path.join(getRuntimeRoot(baseDir, options), ".run"));
}

export function getControlTokenPath(
  baseDir: string = process.cwd(),
  options: RuntimePathOptions = {},
): string {
  return path.join(getRunDir(baseDir, options), "control-token.json");
}

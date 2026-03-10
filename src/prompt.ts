import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function readBootstrap(workdir: string): string | null {
  const file = join(workdir, "BOOTSTRAP.md");
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(options: {
  workdir: string;
  sandbox: string;
  extraPrompt?: string;
  isFirstTurn?: boolean;
}): string {
  const platform = process.platform;
  const env = `[环境] 工作目录=${options.workdir} sandbox=${options.sandbox} os=${platform}`;

  const launchRule = [
    "启动应用程序时必须确保应用独立于当前进程运行，不会因为当前命令结束而关闭：",
    platform === "darwin"
      ? '- macOS：使用 `open -a "应用名"` 命令'
      : '- Linux：使用 `setsid <command> &>/dev/null &` 或 `nohup <command> &>/dev/null &`',
    "- 禁止直接执行应用二进制文件（除非已用上述方式包裹）",
  ].join("\n");

  if (options.isFirstTurn !== false) {
    const bootstrap = readBootstrap(options.workdir);
    if (bootstrap) {
      const parts = [env, launchRule, bootstrap];
      if (options.extraPrompt?.trim()) parts.push(options.extraPrompt.trim());
      return parts.join("\n\n");
    }
  }

  const parts = [env, launchRule];

  if (options.isFirstTurn !== false) {
    parts.push(
      [
        "请先读取工作目录下的 AGENTS.md、MEMORY.md 和 PROFILE.md（如果存在），遵循其中的规则，并结合记忆上下文来回复用户。",
        "这是新会话的第一条消息，后续消息不会重复此提示。",
      ].join("\n"),
    );
  }

  if (options.extraPrompt?.trim()) {
    parts.push(options.extraPrompt.trim());
  }

  return parts.join("\n\n");
}

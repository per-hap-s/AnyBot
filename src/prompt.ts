export function buildSystemPrompt(options: {
  workdir: string;
  sandbox: string;
  extraPrompt?: string;
}): string {
  const platform = process.platform;
  const parts = [
    `[环境] 工作目录=${options.workdir} sandbox=${options.sandbox} os=${platform}`,
    [
      "启动应用程序时必须确保应用独立于当前进程运行，不会因为当前命令结束而关闭：",
      platform === "darwin"
        ? '- macOS：使用 `open -a "应用名"` 命令'
        : '- Linux：使用 `setsid <command> &>/dev/null &` 或 `nohup <command> &>/dev/null &`',
      "- 禁止直接执行应用二进制文件（除非已用上述方式包裹）",
    ].join("\n"),
  ];

  if (options.extraPrompt?.trim()) {
    parts.push(options.extraPrompt.trim());
  }

  return parts.join("\n\n");
}

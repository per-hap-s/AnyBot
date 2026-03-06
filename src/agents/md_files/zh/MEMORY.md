---
summary: "飞书 Codex 代理的长期项目记忆"
read_when:
  - 构建系统提示词
---

## 项目定位

`CodexDesktopControl` 是一个飞书机器人桥接服务：

- 用飞书长连接接收消息
- 把文本消息转给本机 `codex exec`
- 再把结果回发到飞书
- 默认只保留少量内存中的会话历史，进程重启后会丢失

## 当前已知行为

- 私聊里默认直接回复
- 群聊里默认只有被 @ 才回复
- 非文本消息会返回兜底提示
- 收到消息后会先尝试加一个已收到 reaction
- `CODEX_SANDBOX` 控制 Codex 可执行权限

## 常用命令

```bash
npm run start --prefix /Users/erhu/code/python/CodexDesktopControl
npm run check --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:start --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:status --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:stop --prefix /Users/erhu/code/python/CodexDesktopControl
```

## 提示词加载

- 启动后会先把默认模板复制到 `CODEX_WORKDIR`
- 运行时优先读取 `CODEX_WORKDIR` 下的 `AGENTS.md`、`PROFILE.md`、`MEMORY.md`、`SOUL.md`
- 如果 `CODEX_WORKDIR` 下存在 `BOOTSTRAP.md`，就进入首次引导模式
- `CODEX_SYSTEM_PROMPT` 作为额外补充提示词追加
- `CODEX_PROMPT_DIR` 可覆盖默认模板来源目录

## 已知限制

- 飞书消息回复是纯文本场景，长篇格式化内容体验一般
- 如果没有实际读文件或执行命令，就不能假装已经确认事实
- prompt 越长，每轮调用成本越高，所以这里应只保留长期稳定信息

## 未来适合记录的内容

- 用户稳定偏好
- 常用仓库路径
- 常见故障与排查顺序
- 环境变量约定
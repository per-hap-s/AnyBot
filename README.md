# CodexDesktopControl

`CodexDesktopControl` 用飞书长连接模式把飞书机器人接到本机的 `codex` CLI，让你可以直接在飞书里把消息转给这台机器上的 Codex。

## 功能

- 通过飞书长连接接收 `im.message.receive_v1` 事件
- 把用户发来的文本转发给本地 `codex exec`
- 由机器人把结果回复回飞书
- 按会话保存一小段内存中的上下文历史
- 默认在私聊直接回复，在群聊里仅被 @ 时回复

## 配置步骤

1. 复制 `.env.example` 为 `.env`
2. 填写以下配置：
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - 如果需要，再填写 `CODEX_WORKDIR`
3. 安装依赖：

```bash
npm install --prefix /Users/erhu/code/python/CodexDesktopControl
```

4. 启动机器人：

```bash
npm run start --prefix /Users/erhu/code/python/CodexDesktopControl
```

也可以使用后台控制脚本：

```bash
npm run bot:start --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:status --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:stop --prefix /Users/erhu/code/python/CodexDesktopControl
```

## 飞书侧必需配置

在飞书开放平台应用设置里：

- 开启机器人能力
- 开启长连接模式的事件订阅
- 订阅 `im.message.receive_v1`
- 给机器人开通发送消息权限
- 配置完成后发布应用

## 环境变量说明

- `FEISHU_GROUP_CHAT_MODE`：可选值是 `mention` 或 `all`
- `FEISHU_BOT_OPEN_ID`：可选。用于在 `mention` 模式下只响应“明确 @ 机器人本身”的消息；如果不填，只要消息里带 @ 就可能触发回复。
- `FEISHU_ACK_REACTION`：机器人收到消息后，立即给原消息加的 reaction，默认是 `OK`；留空可关闭。
- `CODEX_BIN`：默认为 `codex`
- `CODEX_MODEL`：可选，用于覆盖 `codex exec` 的模型参数
- `CODEX_SANDBOX`：可选，默认是 `read-only`。只允许 `read-only`、`workspace-write`、`danger-full-access` 这 3 个值，会原样传给 `codex exec -s`。
- `CODEX_SYSTEM_PROMPT`：可选。额外追加到内置提示词后的系统提示词
- `CODEX_PROMPT_DIR`：可选。覆盖默认模板目录；默认读取 `src/agents/md_files/zh`
- `CODEX_WORKDIR`：传给 `codex exec` 的工作目录

## 说明

- 会话历史只保存在内存里，进程重启后会丢失
- 机器人会先给你的消息加一个“已收到”的 reaction，再生成完整回复
- 非文本消息目前会返回兜底提示
- 长连接模式不需要公网回调地址
- 这台机器本地需要先能正常使用 `codex`
- 首次启动时会把默认的 `AGENTS.md`、`PROFILE.md`、`MEMORY.md`、`SOUL.md`、`BOOTSTRAP.md`、`HEARTBEAT.md` 初始化到 `CODEX_WORKDIR`
- 运行时会优先读取 `CODEX_WORKDIR` 里的 `AGENTS.md`、`PROFILE.md`、`MEMORY.md`、`SOUL.md` 来构建 system prompt
- 只要 `CODEX_WORKDIR/BOOTSTRAP.md` 还存在，机器人就会保持首次引导模式；引导完成并删除该文件后，恢复普通协作模式

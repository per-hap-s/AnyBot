# AnyBot VPS 原样迁移

本文档对应当前仓库的 VPS 迁移方案，目标是把本机正在运行的 AnyBot 运行态原样迁到现有 `Ubuntu 24.04.2` VPS，并让 VPS 成为唯一生产实例。

## 目标形态

- 运行用户：`openclaw`
- 代码目录：`/home/openclaw/AnyBot`
- 运行根目录：`/home/openclaw/.anybot`
- Codex 工作目录：`/home/openclaw/.openclaw/workspace/anybot-rescue`
- Web 面板：`http://150.158.75.168:19981`
- Web 保护：应用内 `Basic Auth`
- Codex 自定义 API：`http://216.167.83.89:18080/v1`

## 必迁状态

从当前本机 AnyBot 复制这些内容：

- `.data/chat.db`
- `.data/chat.db-wal`
- `.data/chat.db-shm`
- `.data/channels.json`
- `.data/model-config.json`
- `.data/proxy.json`
- `codex-assistant/`

当前已知不需要迁：

- `.data/runtime/`
- `tmp/uploads/`

## VPS 预部署

1. 上传代码到 `/home/openclaw/AnyBot`
2. 创建目录：
   - `/home/openclaw/.anybot-staging`
   - `/home/openclaw/.openclaw/workspace/anybot-rescue`
   - `/home/openclaw/.codex`
3. 写入 `/home/openclaw/.codex/config.toml`
4. 将当前 AnyBot 运行态复制到 `/home/openclaw/.anybot-staging`
5. 仅在 staging 的 `channels.json` 中临时把 `telegram.enabled` 改为 `false`
6. 通过 `systemd Environment=` / `EnvironmentFile=` 或同等方式注入生产环境变量；仓库内 `.env` 只作为缺省值来源，不能覆盖 VPS 显式配置
7. 构建并启动 staging：

```bash
cd /home/openclaw/AnyBot
npm install
npm run build:service
ANYBOT_RUNTIME_ROOT=/home/openclaw/.anybot-staging node dist/service/index.js
```

## 正式切换

1. 停掉本机 AnyBot，确保它不再 polling 当前 Telegram bot
2. 把最新一致性状态复制到 `/home/openclaw/.anybot`
3. 恢复正式 `channels.json`，保留现有 Telegram token
4. 启动 `anybot.service`
5. 验证 Telegram、记忆、Web 面板、OpenClaw 救援链路

## systemd --user 示例

可直接参考 [anybot-vps.service.example](/D:/CodexProjects/AnyBot/docs/anybot-vps.service.example)。

## 验证清单

- `npm run check`
- `npm run build:service`
- Codex 启动自检 `text / resume / image` 全通过
- 未认证访问 Web 返回 `401`
- 认证后可正常打开面板
- Telegram bot 在 VPS 上成为唯一 poller
- `chat.db` 计数与迁移前一致
- AnyBot 内可执行 `openclaw status --deep`

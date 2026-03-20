# AnyBot

This minimized AnyBot build only supports:

- `Codex CLI` as the only provider
- `Feishu` and `Telegram` as messaging channels
- The built-in `Web UI` for local chat and configuration

The goal of this version is to stay minimal while supporting both:

- `npm start` for foreground service mode
- a Windows tray host based on Electron for background management

## What It Supports

- Local Web UI chat
- Codex model switching
- Feishu long-connection messaging
- Feishu image input and file/image reply upload
- Telegram private-chat polling, queue/supplement decisions, and final reply replacement
- Telegram mixed runtime status updates for long-running Codex tasks
- Local session persistence
- Proxy configuration and connectivity test

## What Was Removed

- Gemini / Cursor / Qoder
- QQ
- Provider switching
- Skills management UI
- `setup.sh` and daemon scripts

## Requirements

- Node.js 18+
- Codex CLI installed
- Prefer setting `CODEX_BIN` explicitly instead of relying on PATH

## Quick Start

1. Copy the env template:

```bash
cp .env.example .env
```

2. Edit `.env` and set at least:

```env
PROVIDER=codex
CODEX_BIN=C:\path\to\codex.exe
CODEX_WORKDIR=D:\your\workspace
WEB_PORT=19981
```

If `codex` is already available in PATH, you can leave `CODEX_BIN` empty or set it to `codex`.

3. Install dependencies and start:

```bash
npm install
npm start
```

Then open:

```text
http://localhost:19981
```

## Windows Tray Mode

Tray mode is now the recommended Windows entrypoint. It starts and monitors the AnyBot service, exposes quick controls from the system tray, and supports launch-at-login.

The tray config file is stored at `.data/tray-config.json`. Set `serviceAutoStartDelaySeconds` to delay the post-login AnyBot auto-start, for example:

```json
{
  "launchAtLogin": true,
  "serviceAutoStartOnLogin": true,
  "serviceAutoStartDelaySeconds": 45
}
```

Development:

```bash
npm run dev:tray
```

Local built tray:

```bash
npm run start:tray
```

Windows installer:

```bash
npm run pack:win
```

## Channel Config

Channel config is stored in `.data/channels.json`. Feishu and Telegram are supported:

```json
{
  "feishu": {
    "enabled": true,
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "groupChatMode": "mention",
    "botOpenId": "ou_xxx",
    "ackReaction": "OK",
    "ownerChatId": "oc_xxx"
  },
  "telegram": {
    "enabled": true,
    "botToken": "123456:ABC...",
    "ownerChatId": "123456789",
    "privateOnly": true,
    "allowGroups": false,
    "pollingTimeoutSeconds": 30,
    "finalReplyMode": "replace"
  }
}
```

`telegram.finalReplyMode` supports:

- `replace`: replace the in-progress status message with the final answer
- `replace_and_notify`: still replace in place, and also send a short reminder message to trigger a Telegram notification; the reminder auto-deletes after about 15 seconds

You can update this from the Web UI Telegram page or from the Windows tray menu.

## Telegram Runtime Statuses

Telegram now surfaces Codex runtime progress in a mixed status mode. The status message stays concise by default and only adds a short detail when it is useful, such as the command name, tool name, or search query.

Runtime phases:

- `已收到消息`
- `正在理解问题`
- `正在执行命令`
- `正在搜索网页`
- `正在调用工具`
- `正在修改文件`
- `正在整理回复`
- `正在发送回复`

Status updates are throttled to avoid Telegram edit spam, older task attempts cannot overwrite the current run, and the processing text now follows the latest real activity instead of getting stuck on the first `正在整理回复`.

## Provider Timeout Behavior

Codex runs now use two timeout guards:

- `idleTimeoutMs = 120000`: fail only when there has been no effective provider progress for 120 seconds and there is no active long-running command / web search / MCP tool call / file change step
- `maxRuntimeMs = 1800000`: absolute 30 minute ceiling for a single provider run

Only `resume` runs that hit the idle timeout before producing any real progress are retried as a fresh session. Long single-step work is protected from idle timeout and falls back to the max runtime guard instead. This V1 implementation does not introduce a durable background queue and does not support mid-run steering of an existing `codex exec --json` process.

## Environment Variables

```env
PROVIDER=codex
CODEX_BIN=
CODEX_MODEL=
CODEX_SANDBOX=read-only
CODEX_SYSTEM_PROMPT=
CODEX_WORKDIR=
WEB_PORT=19981
LOG_LEVEL=info
LOG_INCLUDE_CONTENT=false
LOG_INCLUDE_PROMPT=false
MEMORY_EXTRACTION_MODEL=gpt-5.4
MEMORY_PROMOTION_MODEL=gpt-5.4
SILICONFLOW_API_KEY=
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3
SILICONFLOW_EMBEDDING_URL=https://api.siliconflow.cn/v1/embeddings
SILICONFLOW_EMBEDDING_TIMEOUT_MS=20000
```

Memory notes:

- Durable memory extraction runs asynchronously after a private-chat reply and defaults to `gpt-5.4`.
- Canonical memory promotion also runs asynchronously and defaults to `gpt-5.4`.
- New memory entries are embedded asynchronously through SiliconFlow with `BAAI/bge-m3`.
- Memory indexing is currently limited to private chats (`web`, Feishu owner chat, Telegram owner chat).
- Daily memory stays granular; duplicate merging is deferred to canonical-memory promotion.
- Retrieval is enabled for canonical memory only; daily memory is not retrieved yet.

## Main API Routes

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `POST /api/sessions/:id/messages`
- `POST /api/upload`
- `GET /api/model-config`
- `PUT /api/model-config`
- `GET /api/channels`
- `PUT /api/channels/feishu`
- `GET /api/proxy`
- `PUT /api/proxy`
- `POST /api/proxy/test`
- `POST /api/send` only supports `{ "channel": "feishu", ... }`
- `GET /api/status`
- `POST /api/control/shutdown` requires `x-anybot-control-token`

## Windows Notes

This build now includes:

- foreground service mode via `npm start`
- a Windows tray host with start, stop, restart, status, logs, and launch-at-login
- local status and shutdown control APIs for the tray host

Packaging caveat:

- `better-sqlite3` must be rebuilt against Electron before packaging
- if `electron-builder install-app-deps` fails on Windows with `EPERM`, stop any running AnyBot process and run `npm install` again

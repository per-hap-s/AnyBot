# AnyBot

This minimized AnyBot build only supports:

- `Codex CLI` as the only provider
- `Feishu` as the only messaging channel
- The built-in `Web UI` for local chat and configuration

The goal of this version is to stay minimal while supporting both:

- `npm start` for foreground service mode
- a Windows tray host based on Electron for background management

## What It Supports

- Local Web UI chat
- Codex model switching
- Feishu long-connection messaging
- Feishu image input and file/image reply upload
- Local session persistence
- Proxy configuration and connectivity test

## What Was Removed

- Gemini / Cursor / Qoder
- QQ / Telegram
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

## Feishu Config

Channel config is stored in `.data/channels.json`. Only `feishu` is supported:

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
  }
}
```

You can also save it from the `Feishu` page in the Web UI.

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

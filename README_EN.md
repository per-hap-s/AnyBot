# AnyBot

This minimized AnyBot build keeps the stack narrow on purpose:

- `Codex CLI` is the only main provider.
- `Telegram`, `Feishu`, and the built-in `Web UI` are the active chat surfaces.
- Telegram now has a durable V2 background-task path; Web and Feishu still use the existing foreground flow.

The goal is to stay small enough to operate locally while still supporting:

- `npm start` for foreground service mode
- a Windows tray host based on Electron for background management

## What It Supports

- Local Web UI chat
- Codex model switching
- Feishu long-connection messaging
- Feishu image input and file/image reply upload
- Telegram private-chat polling
- Telegram durable background tasks with persisted queue, recovery, and supplement-or-queue decisions
- Telegram mixed runtime status updates for long-running Codex tasks
- Telegram query-completion repair for lookup-style turns
- Local session persistence
- Proxy configuration and connectivity test
- Durable memory extraction, retrieval, rerank, and promotion

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

```powershell
Copy-Item .env.example .env
```

2. Edit `.env` and set at least:

```env
PROVIDER=codex
CODEX_BIN=C:\path\to\codex.exe
CODEX_WORKDIR=D:\your\workspace
WEB_HOST=127.0.0.1
WEB_PORT=19981
```

If `codex` is already available in PATH, you can leave `CODEX_BIN` empty or set it to `codex`.

3. Install dependencies and start:

```powershell
npm install
npm start
```

Then open:

```text
http://localhost:19981
```

## VPS Deployment

For the current VPS migration path, the production shape is:

- run as the Linux user `openclaw`
- use `node dist/service/index.js` instead of `npm start`
- keep the existing Telegram bot token and migrate the current `.data/chat.db` state
- point Codex CLI at the existing custom `Responses API` endpoint instead of official login/API
- expose the Web UI on `0.0.0.0:19981` with built-in `Basic Auth`

Recommended production env values:

```env
CODEX_HOME=/home/openclaw/.codex
ANYBOT_RUNTIME_ROOT=/home/openclaw/.anybot
CODEX_WORKDIR=/home/openclaw/.openclaw/workspace/anybot-rescue
WEB_HOST=0.0.0.0
WEB_PORT=19981
ANYBOT_WEB_BASIC_AUTH_USER=your-user
ANYBOT_WEB_BASIC_AUTH_PASSWORD=your-password
LOG_TO_STDOUT=true
```

Note: the repo-local `.env` now acts only as a fallback source. Explicit external environment values such as `systemd Environment=` and `EnvironmentFile=` take precedence and are no longer overridden by `.env`.

Production build and start:

```powershell
npm run build:service
node dist/service/index.js
```

See [docs/anybot-vps-migration.md](/D:/CodexProjects/AnyBot/docs/anybot-vps-migration.md) for the full migration and staging flow.

## Windows Tray Mode

Tray mode is the recommended Windows entrypoint. It starts and monitors the AnyBot service, exposes quick controls from the system tray, and supports launch-at-login.

The tray config file is stored at `.data/tray-config.json`. Set `serviceAutoStartDelaySeconds` to delay the post-login AnyBot auto-start, for example:

```json
{
  "launchAtLogin": true,
  "serviceAutoStartOnLogin": true,
  "serviceAutoStartDelaySeconds": 45
}
```

Development:

```powershell
npm run dev:tray
```

Local built tray:

```powershell
npm run start:tray
```

Windows installer:

```powershell
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
- `replace_and_notify`: still replace in place, and also send a lighter reminder message (`上方回复已更新`) to trigger a Telegram notification; the reminder auto-deletes after about 15 seconds

You can update this from the Web UI Telegram page or from the Windows tray menu.

## Telegram V2 Background Tasks

Telegram now runs on a durable task layer backed by SQLite:

- Task state is persisted in `telegram_tasks`, `telegram_task_inputs`, `telegram_attempts`, and `telegram_poll_state`.
- `node:test` now uses an isolated temporary runtime root, so tests no longer write into the real `.data/chat.db` or Telegram polling state.
- Incoming Telegram messages are no longer represented only by in-memory `running / decision / queued / pendingRestart`.
- On restart, Telegram polling resumes from the persisted `last_update_id + 1` instead of jumping to the latest offset.
- A running attempt can be superseded by a newer revision; superseded attempts do not write shared session history or memory.

Current V2 boundaries:

- V2 only applies to `Telegram`.
- `Web` and `Feishu` keep the existing foreground execution path.
- The main execution provider is still `codex exec --json`.
- V2 does not add mid-run steering of an existing provider process.

## Telegram Runtime Statuses

Telegram surfaces runtime progress in a mixed status mode. The status message stays concise by default and only adds a short sanitized detail when useful, such as a command name, tool name, short search topic, or a compact Codex plan summary.

Runtime statuses:

- `已收到消息`
- `正在理解图片`
- `正在理解问题`
- `正在执行命令`
- `正在搜索网页`
- `正在调用工具`
- `正在修改文件`
- `正在整理回复`
- `正在补全查询结果`
- `正在发送回复`
- `当前计划：2/5 已完成；当前步骤：正在检查代码` (only when Codex emits an internal `todo_list` / plan event)

Display rules:

- File-change status does not expose long local file paths.
- Command status only shows a short command summary, not full output.
- Web search status only shows a short topic, not raw result bodies.
- Telegram prompts now lightly steer Codex toward short Chinese internal plan steps.
- Plan status is normalized into natural Chinese stages such as `正在分析问题 / 正在查资料 / 正在检查代码 / 正在修改实现 / 正在整理结果`.
- Plan status stays as a compact Chinese summary instead of exposing the full checklist or raw internal phrasing.
- `已收到消息` and later running/timeout/sending states now reuse the same Telegram status bubble instead of splitting into two cards.
- Telegram final replies are also normalized toward chat-style Chinese and strip local absolute paths, Markdown file links, and reference-code lists before sending.
- Telegram also rewrites internal state names, class names, database names, and process-control terms into simpler user-facing Chinese, including the last remaining terms such as `cancelled`, `二选一决策`, and `中止控制器`.
- Telegram final replies are expected to stay conclusion-first, with only a small amount of follow-up detail instead of long implementation-heavy prose.
- Older attempts cannot overwrite the current task status.
- Status updates are throttled to avoid Telegram edit spam.
- Processing text follows the latest real activity instead of getting stuck on the first finalizing event.

## Provider Timeout Behavior

Codex runs now use three timeout guards:

- `idleTimeoutMs = 120000`: fail only when there has been no effective provider progress for 120 seconds and there is no active long-running command / web search / MCP tool call / file change step
- `longStepStallTimeoutMs = 600000`: once a long-running step has started, fail it if there are no new JSON runtime events for 10 minutes
- `maxRuntimeMs = 3600000`: absolute 60-minute ceiling for a single provider run

Only `resume` runs that hit idle timeout before any real progress are retried as a fresh session. Long single-step work is protected from normal idle timeout, but it is still cut off if the long step goes silent for 10 minutes with no new runtime events.

Telegram failure text distinguishes:

- idle timeout
- long-step stalled timeout
- max runtime
- incomplete lookup failure
- generic provider failure

## Query Completion Guard

Lookup-style turns cannot end on placeholder-only replies such as `I will check that.` or vague unresolved endings such as `Not sure.`.

For those turns, AnyBot makes one in-session continuation attempt to force a usable closure. The next reply must do one of these:

- provide the actual result
- clearly explain why the result cannot be obtained right now

Explicit failure replies are valid terminal outcomes. If the model still fails to provide either a result or a clear failure reason after the repair attempt, Telegram shows a user-visible failure message instead of storing a half-finished placeholder reply.

## Telegram Supplement Router Sidecar

Telegram V2 adds an optional supplement router sidecar for `supplement / queue / unclear` classification:

- Hard rules run first.
- Only gray-area cases call the sidecar model.
- The sidecar path is isolated from the main Codex execution path.
- Low-confidence, timeout, circuit-open, or invalid-output cases fall back to the manual Telegram choice instead of auto-routing.
- The service reads explicit env vars only; it does not read Codex desktop `config.toml`.

The default sidecar model is `gpt-5.4-mini`.

## Environment Variables

```env
PROVIDER=codex
CODEX_BIN=
CODEX_MODEL=gpt-5.4
CODEX_SANDBOX=danger-full-access
CODEX_SYSTEM_PROMPT=
CODEX_WORKDIR=
CODEX_HOME=
ANYBOT_RUNTIME_ROOT=
WEB_HOST=0.0.0.0
WEB_PORT=19981
ANYBOT_WEB_BASIC_AUTH_USER=
ANYBOT_WEB_BASIC_AUTH_PASSWORD=
ANYBOT_WEB_BASIC_AUTH_REALM=AnyBot
LOG_LEVEL=info
LOG_INCLUDE_CONTENT=false
LOG_INCLUDE_PROMPT=false
LOG_TO_STDOUT=
MEMORY_EXTRACTION_MODEL=gpt-5.4
MEMORY_PROMOTION_MODEL=gpt-5.4
SILICONFLOW_API_KEY=
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3
SILICONFLOW_EMBEDDING_URL=https://api.siliconflow.cn/v1/embeddings
SILICONFLOW_EMBEDDING_TIMEOUT_MS=20000
SILICONFLOW_RERANK_MODEL=BAAI/bge-reranker-v2-m3
SILICONFLOW_RERANK_URL=https://api.siliconflow.cn/v1/rerank
SILICONFLOW_RERANK_TIMEOUT_MS=20000
TELEGRAM_ROUTER_ENABLED=false
TELEGRAM_ROUTER_BASE_URL=
TELEGRAM_ROUTER_API_KEY=
TELEGRAM_ROUTER_MODEL=gpt-5.4-mini
TELEGRAM_ROUTER_TIMEOUT_MS=2500
```

Memory notes:

- Durable memory extraction runs asynchronously after a private-chat reply and defaults to `gpt-5.4`.
- Canonical memory promotion also runs asynchronously and defaults to `gpt-5.4`.
- New memory entries are embedded asynchronously through SiliconFlow with `BAAI/bge-m3`.
- Retrieval uses canonical memory only and blends vector similarity, keyword overlap, confidence, recency, category hints, and a second-stage SiliconFlow rerank call.
- If rerank is unavailable or fails, retrieval falls back to the coarse blended score instead of disabling memory recall entirely.

## Owner Chat Commands

- `/memory` shows structured-memory counts and category summary
- `/memories` lists active canonical memories
- `/remember <text>` saves a durable fact
- `/profile <text>` saves a durable user/profile fact
- `/forget <text>` rejects matching daily and canonical memories
- `Telegram /stop` stops all active tasks in the current Telegram chat, clears in-progress status bubbles, and keeps the current session context; Telegram groups also accept `/stop@BotUsername`

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

This build includes:

- foreground service mode via `npm start`
- a Windows tray host with start, stop, restart, status, logs, and launch-at-login
- local status and shutdown control APIs for the tray host

Packaging caveat:

- `postinstall` skips Electron rebuild on non-Windows hosts
- `better-sqlite3` must be rebuilt against Electron before packaging
- if `electron-builder install-app-deps` fails on Windows with `EPERM`, stop any running AnyBot process and run `npm install` again

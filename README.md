# CodexDesktopControl

CodexDesktopControl connects a Feishu bot to the local `codex` CLI through Feishu long connection mode, so Feishu messages can be routed into the Codex running on this machine.

## What it does

- Receives `im.message.receive_v1` events through Feishu long connection mode
- Sends user text to the local `codex exec` command
- Replies back into Feishu as the bot
- Keeps short in-memory conversation history per chat
- Defaults to replying in private chats and only when mentioned in group chats

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - optionally `CODEX_WORKDIR`
3. Install dependencies locally:

```bash
npm install --prefix /Users/erhu/code/python/CodexDesktopControl
```

4. Start the bot:

```bash
npm run start --prefix /Users/erhu/code/python/CodexDesktopControl
```

Or use the simple background control scripts:

```bash
npm run bot:start --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:status --prefix /Users/erhu/code/python/CodexDesktopControl
npm run bot:stop --prefix /Users/erhu/code/python/CodexDesktopControl
```

## Required Feishu configuration

In the Feishu Open Platform app settings:

- Enable bot capability
- Enable event subscription in long connection mode
- Subscribe to `im.message.receive_v1`
- Grant message send permission for the bot
- Publish the app after configuration

## Environment variables

- `FEISHU_GROUP_CHAT_MODE`: `mention` or `all`
- `FEISHU_BOT_OPEN_ID`: optional, used to make mention-mode only respond when the bot itself is mentioned. Without it, any group message with mentions will trigger a reply.
- `CODEX_BIN`: defaults to `codex`
- `CODEX_MODEL`: optional model override for `codex exec`
- `CODEX_SANDBOX`: defaults to `read-only`
- `CODEX_SYSTEM_PROMPT`: system prompt prepended before each forwarded Feishu message
- `CODEX_WORKDIR`: working directory passed to `codex exec`

## Notes

- Conversation history is stored only in memory
- Non-text messages currently return a fallback text response
- Long connection mode does not require a public callback URL
- The bot relies on the local machine already being logged into `codex`

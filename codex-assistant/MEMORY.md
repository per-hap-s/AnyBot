# Memory

## Environment

- Workspace root: `D:\CodexProjects\AnyBot`
- AnyBot project: `D:\CodexProjects\AnyBot`
- Assistant memory directory: `D:\CodexProjects\AnyBot\codex-assistant`
- Runtime target: Windows foreground service via `npm start`
- Current IM channel: Feishu only
- Current provider direction: Codex CLI as the personal assistant engine

## Durable Preferences

- The assistant should behave like a long-lived personal assistant, not a one-shot coding bot.
- Keep solutions pragmatic, directly executable, and concise.
- For simple questions, answer first instead of scanning the entire workspace.
- Long-term memory should be file-based and persist across sessions.

## Known Setup

- Feishu long connection has been configured and inbound message receiving works.
- `im.message.receive_v1` is required for inbound Feishu messages.
- `CODEX_BIN` is explicitly configured on Windows and should not rely on PATH.
- `CODEX_WORKDIR` is `D:\CodexProjects\AnyBot`.
- The current default model target is `gpt-5.4`.

## Long-Term Project

- Continue evolving AnyBot into a stable Windows personal-assistant workflow based on AnyBot + Codex CLI + Feishu.

## Lessons

- Store only durable environment, workflow, and project facts here.
- Do not store secrets in this file.
- The bundled Windows screenshot skill helper currently fails because `take_screenshot.ps1` assigns to `$home`, which conflicts with PowerShell's read-only `HOME` variable; use a fallback screenshot command until the script is fixed.
- On this Windows setup, desktop screenshots must use a DPI-aware process; otherwise captures come out at the scaled logical resolution `1707x1067` instead of the physical display resolution `2560x1600`.
- AnyBot Web chat supports provider event streaming, but the Feishu channel currently waits for the final Codex result before replying; perceived latency in Feishu is therefore dominated by `codex exec` completion time rather than message ingress or Lark send time.
- AnyBot Telegram currently does not stream reply content. It only updates Telegram draft/chat-action status while `generateReply()` waits for `provider.run()` to finish, then sends the final reply in one shot.
- AnyBot Telegram status text can linger after the final reply because the current status controller stops refreshing on completion but does not explicitly clear the Telegram draft/status text.
- Telegram lingering-status bug was re-reported after attempted fixes; screenshot evidence suggests at least one status channel still remains uncleared after the final reply.
- Subsequent manual validation showed the lingering Telegram bottom status did not reproduce on at least one later reply, so the issue may now be partially fixed or intermittent.
- Further manual validation showed the lingering Telegram bottom status did not reproduce in consecutive follow-up replies, so treat it as currently fixed unless re-reported.

## Captured Notes

- Add durable environment, workflow, and project facts here.

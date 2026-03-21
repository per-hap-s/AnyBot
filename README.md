# AnyBot

当前这版 AnyBot 有意保持精简：

- 主执行 Provider 只有 `Codex CLI`
- 对话入口保留 `Telegram`、`Feishu` 和内置 `Web UI`
- Telegram 已进入 V2 持久化后台任务模式；Web 和 Feishu 仍走现有前台同步链路

目标是在本地可控、结构尽量简单的前提下，同时支持：

- `npm start` 前台服务模式
- 基于 Electron 的 Windows 托盘后台管理

## 当前能力

- Web UI 本地聊天
- Codex 模型切换
- 飞书长连接收发消息
- 飞书图片输入与文件/图片回复上传
- Telegram 私聊 polling
- Telegram 持久化后台任务、补充/排队决策与重启恢复
- Telegram 长任务运行状态展示
- Telegram 查询类回复补全修复
- 本地会话持久化
- 代理配置与连通性测试
- 结构化记忆抽取、检索、重排与提升

## 不再支持

- Gemini / Cursor / Qoder
- QQ
- Provider 切换
- Skills 管理 UI
- `setup.sh` 和 daemon 脚本

## 运行要求

- Node.js 18+
- 已安装 Codex CLI
- 建议显式设置 `CODEX_BIN`，不要依赖 PATH

## 快速开始

1. 复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

2. 编辑 `.env`，至少设置：

```env
PROVIDER=codex
CODEX_BIN=C:\path\to\codex.exe
CODEX_WORKDIR=D:\your\workspace
WEB_PORT=19981
```

如果 `codex` 已经在 PATH 里，也可以把 `CODEX_BIN` 留空或写成 `codex`。

3. 安装依赖并启动：

```powershell
npm install
npm start
```

启动后访问：

```text
http://localhost:19981
```

## Windows 托盘模式

托盘模式是 Windows 下推荐的入口。它会负责启动和监控 AnyBot 服务，并在系统托盘中提供快捷控制和开机自启。

托盘配置文件位于 `.data/tray-config.json`。可以通过 `serviceAutoStartDelaySeconds` 控制登录后延迟自启，例如：

```json
{
  "launchAtLogin": true,
  "serviceAutoStartOnLogin": true,
  "serviceAutoStartDelaySeconds": 45
}
```

开发模式：

```powershell
npm run dev:tray
```

本地构建后启动托盘：

```powershell
npm run start:tray
```

打包 Windows 安装程序：

```powershell
npm run pack:win
```

## 频道配置

频道配置保存在 `.data/channels.json`，当前支持 `feishu` 和 `telegram`：

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

`telegram.finalReplyMode` 支持：

- `replace`：最终回复直接替换进行中的状态消息
- `replace_and_notify`：仍然原地替换，同时额外发送一条短提醒消息以触发 Telegram 通知；提醒会在约 15 秒后自动删除

这些配置可以在 Web UI 的 Telegram 页面或 Windows 托盘菜单中修改。

## Telegram V2 持久化后台任务

Telegram 现在运行在 SQLite 持久化任务层之上：

- 任务真相落在 `telegram_tasks`、`telegram_task_inputs`、`telegram_attempts`、`telegram_poll_state`
- `node:test` 会自动切到临时 runtime root，不再写入真实 `.data/chat.db` 或 Telegram polling 状态
- 不再只依赖内存里的 `running / decision / queued / pendingRestart`
- 服务重启后会从持久化的 `last_update_id + 1` 继续拉 Telegram updates，不再直接跳到最新 offset
- attempt 可以被更高 revision 的新 attempt 顶替；被顶替的 attempt 不会写共享会话历史和 memory

当前 V2 边界：

- V2 只覆盖 `Telegram`
- `Web` 和 `Feishu` 仍走现有前台执行路径
- 主执行仍然是 `codex exec --json`
- 这一版不做运行中的 steering / 中途引导

## Telegram 运行状态

Telegram 会展示简洁的中文运行状态，必要时只补一小段安全摘要，例如命令名、工具名或搜索词。

当前可见状态：

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

展示规则：

- 文件修改状态不暴露长本地路径
- 命令状态只显示短命令摘要，不显示完整输出
- 网页搜索状态只显示短主题，不展示网页正文
- 旧 attempt 的迟到事件不能覆盖当前任务状态
- 状态更新带节流，避免 Telegram 频繁编辑刷屏
- “处理中”文案跟随最新真实活动，不会因为一次“正在整理回复”就永久锁死

## Provider 超时语义

Codex 当前同时使用两条超时线：

- `idleTimeoutMs = 120000`：只有在 120 秒没有有效进展，且当前不存在活跃长单步时，才判定为无进展超时
- `maxRuntimeMs = 3600000`：单次 provider 运行的绝对上限为 60 分钟

长单步包括：

- `command_execution`
- `web_search`
- `mcp_tool_call`
- `file_change`

因此，正常运行中的长命令、长网页搜索、长工具调用不会被 idle timeout 误杀，而是只受 60 分钟总时长保护。

Telegram 用户侧会区分：

- 无进展超时
- 达到最长运行时长
- 查询补全失败
- 其他普通失败

## 查询完成保护

查询类任务不能停在“我先查一下”这类进度句，也不能停在 `Not sure.` 这类模糊未完成回复。

当前策略：

- 如果用户这一轮明显是在发起查询、核实、搜索或获取最新信息，AnyBot 会检查终态回复是否只是占位或弱答复
- 若终态不合格，AnyBot 会在同一会话里自动补跑一次，并发出 `reply.repair.started` 事件
- 补跑后的回复必须二选一：给出结果，或明确说明为什么现在拿不到结果
- 如果补跑后仍没有结果，也没有明确失败原因，Telegram 会向用户显示失败提示，而不是把半截进度句当最终答案

## Telegram 补充分类 Sidecar

Telegram V2 新增了可选的补充分类 sidecar，用于判断 `supplement / queue / unclear`：

- 先跑硬规则
- 只有灰区才调 sidecar 小模型
- sidecar 路径与主 Codex 执行链隔离，不会干扰主任务
- 低置信、超时、熔断或非法输出时，都会回退到 Telegram 人工二选一
- 服务端只读取显式环境变量，不读取 Codex desktop 的 `config.toml`

默认 sidecar 模型是 `gpt-5.4-mini`。

## 环境变量

```env
PROVIDER=codex
CODEX_BIN=
CODEX_MODEL=gpt-5.4
CODEX_SANDBOX=danger-full-access
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
SILICONFLOW_RERANK_MODEL=BAAI/bge-reranker-v2-m3
SILICONFLOW_RERANK_URL=https://api.siliconflow.cn/v1/rerank
SILICONFLOW_RERANK_TIMEOUT_MS=20000
TELEGRAM_ROUTER_ENABLED=false
TELEGRAM_ROUTER_BASE_URL=
TELEGRAM_ROUTER_API_KEY=
TELEGRAM_ROUTER_MODEL=gpt-5.4-mini
TELEGRAM_ROUTER_TIMEOUT_MS=2500
```

记忆系统补充说明：

- 私聊回复后会异步执行 durable memory extraction，默认模型为 `gpt-5.4`
- canonical memory promotion 也异步执行，默认模型为 `gpt-5.4`
- 新 memory entry 会通过 SiliconFlow 的 `BAAI/bge-m3` 异步生成 embedding
- 检索使用 canonical memory，并综合向量相似度、关键词重叠、置信度、时间新鲜度、类别提示和 SiliconFlow 二阶段 rerank
- 若 rerank 不可用或失败，会回退到粗粒度 blended score，而不是直接关闭 memory recall

## Owner Chat Commands

- `/memory`：查看结构化记忆计数和分类摘要
- `/memories`：列出当前 canonical memories
- `/remember <text>`：保存 durable fact
- `/profile <text>`：保存 durable user/profile fact
- `/forget <text>`：失效匹配的 daily / canonical memories

## 主要接口

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
- `POST /api/send` 仅支持 `{ "channel": "feishu", ... }`
- `GET /api/status`
- `POST /api/control/shutdown` 需要 `x-anybot-control-token`

## Windows 说明

当前版本包含：

- 通过 `npm start` 启动的前台服务模式
- 支持启动、停止、重启、状态、日志和开机自启的 Windows 托盘宿主
- 供托盘调用的本地状态与关停接口

打包时请注意：

- `better-sqlite3` 需要按 Electron 版本完成重建
- 如果 `electron-builder install-app-deps` 因 `EPERM` 失败，先停止正在运行的 AnyBot，再重新执行 `npm install`

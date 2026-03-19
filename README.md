# AnyBot

最小化后的 AnyBot 仅支持：

- `Codex CLI` 作为唯一 Provider
- `飞书` 作为唯一消息通道
- 内置 `Web UI` 作为本地聊天和配置界面

本版本的目标是保持最小可用，同时支持：

- `npm start` 以前台服务模式运行
- 基于 Electron 的 Windows 托盘常驻管理

## 当前能力

- Web UI 本地聊天
- Codex 模型切换
- 飞书长连接收发消息
- 飞书图片输入与附件回传
- 本地会话持久化
- 代理配置与连通性测试

## 不再支持

- Gemini / Cursor / Qoder
- QQ / Telegram
- Provider 切换
- 技能管理页面
- `setup.sh` 和 daemon 脚本

## 运行要求

- Node.js 18+
- 已安装 Codex CLI
- 建议显式设置 `CODEX_BIN`，不要依赖 PATH

## 快速开始

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑 `.env`，至少设置：

```env
PROVIDER=codex
CODEX_BIN=C:\path\to\codex.exe
CODEX_WORKDIR=D:\your\workspace
WEB_PORT=19981
```

如果 `codex` 已经在 PATH 中，也可以把 `CODEX_BIN` 留空或写成 `codex`。

3. 安装依赖并启动：

```bash
npm install
npm start
```

启动后访问：

```text
http://localhost:19981
```

## Windows 托盘模式

托盘模式现在是 Windows 下的推荐入口。它会负责启动和监控 AnyBot 服务，并在系统托盘中提供快捷控制和开机自启开关。

开发模式：

```bash
npm run dev:tray
```

本地构建后启动托盘：

```bash
npm run start:tray
```

打包 Windows 安装程序：

```bash
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

- `replace`：最终回答直接替换状态消息
- `replace_and_notify`：最终回答仍然原地替换，同时额外发送一条短提醒消息以触发 Telegram 提醒；该提醒会在约 15 秒后自动删除

也可以在 Web UI 的 `Telegram` 页面和 Windows 托盘菜单中直接修改。

## 环境变量

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
```

说明：

- `CODEX_BIN`：建议显式填写 Codex CLI 可执行文件路径
- `CODEX_WORKDIR`：Codex 实际执行的工作目录
- `CODEX_SANDBOX`：可选 `read-only` / `workspace-write` / `danger-full-access`

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

当前版本已经包含：

- `npm start` 的前台服务模式
- Windows 托盘宿主，支持启动、停止、重启、状态查看、日志入口和开机自启
- 供托盘调用的本地状态与关停接口

打包时请注意：

- `better-sqlite3` 需要按 Electron 版本完成重建
- 如果 `electron-builder install-app-deps` 因 `EPERM` 失败，请先停止正在运行的 AnyBot 进程，再重新执行 `npm install`

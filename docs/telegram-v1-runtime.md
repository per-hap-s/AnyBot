# Telegram V1.1 运行状态与超时

本次 V1.1 只做前台执行链路的小步增强：

- 把单次运行最长时长从 30 分钟提升到 60 分钟。
- 收紧 Telegram 运行状态细节，避免暴露长路径和长原始文本。
- 为图片消息增加一个 Telegram 侧的“正在理解图片”预状态。
- 在失败提示里区分“无进展超时”和“达到最长运行时长”。

本次仍然不包含：

- 持久化后台队列
- 运行中的 steering / 引导
- 对现有“补充当前任务 / 排队”产品语义的修改

## Telegram 状态

Telegram 当前会显示这些中文状态：

- `已收到消息`
- `正在理解图片`
- `正在理解问题`
- `正在执行命令`
- `正在搜索网页`
- `正在调用工具`
- `正在修改文件`
- `正在整理回复`
- `正在发送回复`

展示规则：

- 默认只显示简洁状态。
- `command_execution` 只显示短命令摘要，不显示长路径、长参数、URL 或明显敏感片段。
- `web_search` 只显示短搜索主题，不显示长 URL。
- `mcp_tool_call` 只显示工具名。
- `file_change` 固定只显示“正在修改文件”，不追加文件路径或输出预览。
- 状态更新仍带去重、节流和 attempt 隔离，避免 Telegram 刷屏和旧任务串台。

## 图片预状态

当 Telegram 批次输入中包含图片时，频道会在 provider 首个真实工作项事件到达前，先显示：

- `正在理解图片`

边界固定为：

- 这是 Telegram 侧 UI 预状态，不是 Codex 原生运行事件。
- 它不参与 `idle timeout`、`hadProgress`、fresh retry 判定。
- `thread.started` / `turn.started` 不会立刻覆盖它。
- 一旦收到首个真实 `item.started` / `item.completed` 工作项事件，就切回正常 provider 状态映射。
- 旧 attempt 的迟到状态不会复活或覆盖当前任务。

## 超时规则

Provider 当前同时使用两条判据：

- `idleTimeoutMs = 120000`
  含义：120 秒没有有效进展，并且当前没有活跃长单步工作项时，判定为无进展超时。
- `maxRuntimeMs = 3600000`
  含义：单次运行的绝对上限是 60 分钟。

长单步工作项包括：

- `command_execution`
- `web_search`
- `mcp_tool_call`
- `file_change`

这些步骤一旦开始，就不再受 `idle timeout` 影响，只受 `maxRuntimeMs` 兜底。

Telegram 用户侧的失败提示会区分：

- `本次任务因长时间无进展而超时，请稍后重试。`
- `本次任务已达到最长运行时长（60 分钟），请拆分任务后重试。`

其他 provider 失败仍显示通用错误提示。

有效进展事件包括：

- `thread.started`
- `turn.started`
- 工作项的 `item.started` / `item.completed`
- `turn.completed`

以下内容不算有效进展：

- typing 心跳
- stderr 文本
- 非 JSON 输出
- 解析失败或空事件

## 续聊重试

只有满足以下条件时，`resume` 才会自动 fresh retry：

- 当前是 `resume` 路径
- 命中的是 `idle timeout`
- 本次尝试里还没有出现任何真实工作事件

只要已经有真实进展，就不会再自动 fresh retry，而是按当前任务超时或失败处理。

## 查询完成保护

- 对用户可见的聊天链路里，像 `I will check that.`、`我先查一下。` 这类纯占位终态回复，不再被当成查询任务的最终结果。
- 当用户这一轮明显是在发起查询或核实时，AnyBot 会在同一会话里自动补跑一次，要求返回真正的最终答案。
- 在补跑成功前，这类占位语不会被写成 Telegram、Feishu 或 Web 聊天历史里的最终助手回复。

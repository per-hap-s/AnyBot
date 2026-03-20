# Telegram V1 运行状态与超时

本次 V1 只做两件事：

- 让 Telegram 能看见 Codex 当前在做什么。
- 把超时从“总时长超时”改成“无进展超时 + 最大运行时长”。

这次不包含：

- 持久化后台队列
- 运行中的 steering / 引导
- 对现有“补充当前任务 / 排队”产品语义的修改

## Telegram 状态

Telegram 现在会把 provider 事件映射为简洁中文状态：

- `已收到消息`
- `正在理解问题`
- `正在执行命令`
- `正在搜索网页`
- `正在调用工具`
- `正在修改文件`
- `正在整理回复`
- `正在发送回复`

展示规则：

- 默认只显示简洁状态。
- 必要时追加有限细节，只允许显示命令名、工具名或搜索词摘要。
- 不展示完整命令输出，不展示网页正文，不展示原始 JSON。
- 状态更新带去重和节流，避免 Telegram 频繁编辑。
- 旧任务或旧尝试的迟到事件不会覆盖当前任务状态。
- 处理中状态会跟随“当前最新活动”更新，不会因为先出现一次“正在整理回复”就永久锁死。

## 超时规则

Provider 现在同时使用两条判据：

- `idleTimeoutMs = 120000`
  含义：120 秒没有任何有效进展事件，且当前不存在正在运行的长单步工作项时，判定为无进展超时。
- `maxRuntimeMs = 1800000`
  含义：单次运行的绝对上限为 30 分钟。

长单步工作项包括：

- `command_execution`
- `web_search`
- `mcp_tool_call`
- `file_change`

这些步骤一旦已经开始，就不再受 idle timeout 影响，只受 `maxRuntimeMs` 兜底。

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

只有满足下面条件时，续聊才会自动 fresh retry：

- 当前是 `resume` 路径
- 命中的是 `idle timeout`
- 本次尝试里还没有出现任何真实工作事件

只要已经有真实进展，就不会再自动 fresh retry，而是按当前任务超时或失败处理。

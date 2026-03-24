# Telegram 运行状态、超时与 V2 说明

这份文档用于说明当前 Telegram 链路里，用户真正能看到什么，以及 V1.1 与 V2 分别改了什么。

## 先说现在的整体结构

当前项目里：

- `Telegram` 已切到 V2 持久化后台任务模式
- `Web` 和 `Feishu` 仍保留现有前台同步执行模式
- 主执行 provider 仍然只有 `codex exec --json`
- 当前版本仍然不支持运行中的 steering / 中途引导

也就是说，这份文档里的“运行状态”和“超时语义”依然有效，但 Telegram 的任务承载方式已经从纯内存前台批次升级成了持久化后台任务。

## Telegram 当前可见状态

Telegram 当前会显示这些中文状态：

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
- `当前计划：2/5 已完成；当前步骤：正在检查代码`（仅当 Codex 发出内部 `todo_list` 计划事件时出现）

## Telegram 命令

- `/stop`：立即停止当前 Telegram chat 里的 `decision_pending / queued / running / waiting_next_attempt` 任务
- `/stop` 会主动中止当前运行中的 provider（执行进程），并清理对应的状态气泡
- `/stop` 不会清空当前 session（会话上下文）；如果要从全新会话继续，仍然使用 `/new`
- Telegram 群聊同样支持 `/stop@BotUsername`

这些状态来自两部分：

- provider 归一化事件
- Telegram 自己补的一层 UI 预状态

其中：

- `正在理解图片` 是 Telegram 侧在真正工作项出现前给出的预状态，不是 Codex 原生事件
- `正在补全查询结果` 来自查询完成保护阶段的 `reply.repair.started`

## 状态展示规则

为了让状态可读而且不刷屏，当前展示有这些固定约束：

- 默认只显示简短中文状态
- 必要时只追加很短的细节摘要
- 命令状态只显示短命令名，不展示完整命令输出
- 工具状态只显示工具名
- 搜索状态只显示简短搜索词
- 文件修改状态固定显示“正在修改文件”，不显示长文件路径
- Telegram prompt 会轻量引导 Codex 把内部计划写成简短中文阶段
- 计划状态会优先归一成自然中文阶段，例如“正在分析问题 / 正在查资料 / 正在检查代码 / 正在修改实现 / 正在整理结果”
- 计划状态只显示“x/y 已完成 + 当前步骤摘要”，不展开完整内部 checklist，也不直接透传生硬内部原句
- `已收到消息` 和后续运行中 / 超时 / 发送状态会复用同一条状态气泡，不再拆成两条卡片
- Telegram 最终回复会做聊天化净化，不直接把本地绝对路径、Markdown 文件链接或“参考代码”清单原样发给用户
- 除了去路径和去引用外，Telegram 还会把内部状态名、类名、数据库名和进程控制术语继续压成更自然的用户态中文，不再直出 `cancelled`、`二选一决策`、`中止控制器` 这类词
- Telegram 最终回复默认优先给一句结论，再补少量说明，不让实现细节压过结论
- 旧 attempt 的迟到事件不能覆盖当前任务状态
- 状态更新会节流，避免 Telegram edit spam
- “处理中”文本会跟随最新真实活动变化，不会因为一次“正在整理回复”就锁死

## V1.1 的超时语义

当前 provider 同时使用三条超时线：

- `idleTimeoutMs = 120000`
- `longStepStallTimeoutMs = 600000`
- `maxRuntimeMs = 3600000`

含义如下：

- `idle timeout`：120 秒没有有效进展，且当前没有活跃长单步时，才算无进展超时
- `long step stalled timeout`：已经进入长单步后，如果连续 10 分钟没有任何新的 JSON runtime event，就判定为长步骤失联超时
- `max runtime`：单次 provider 运行的绝对最长时长是 60 分钟

长单步只包括：

- `command_execution`
- `web_search`
- `mcp_tool_call`
- `file_change`

所以：

- 长命令、长网页搜索、长工具调用、长文件修改期间，不会被普通 idle timeout 误杀
- 但如果长单步已经开始后 10 分钟完全没有任何新 runtime event，系统会把它当成卡死并收口
- 无论如何，单次 provider 运行仍受 60 分钟的 `maxRuntimeMs` 保护

### 什么算“有效进展”

以下事件会刷新进展时间：

- `thread.started`
- `turn.started`
- 工作项的 `item.started`
- 工作项的 `item.completed`
- `turn.completed`

以下内容不算有效进展：

- typing 心跳
- stderr 文本
- 非 JSON 输出
- 解析失败的行
- 空事件

## Telegram 用户侧失败提示

Telegram 现在会区分以下几类失败：

- `本次任务因长时间无进展而超时，请稍后重试。`
- `本次任务中的长步骤长时间没有任何新进展，已中止本轮并准备继续后续任务。`
- `本次任务已达到最长运行时长（60 分钟），请拆分任务后重试。`
- `这次查询没有拿到结果，也没有明确失败原因，请稍后重试。`
- 其他 provider 失败统一走通用错误提示

这里的区分只是用户提示优化：

- 不代表加入了后台队列之外的新执行模式
- 也不代表加入了运行中 steering

## 查询完成保护

查询类任务不能停在这些中间态：

- `我先查一下`
- `I will check that.`
- `Not sure.`
- 其他模糊、未闭合、只有进度没有结果的句子

当前保护策略：

- 如果用户这一轮明显是在发起查询、核实、搜索或获取最新信息，系统会检查终态回复是否只是占位语
- 如果终态回复不合格，系统会在同一会话里自动补跑一次
- 这一步会发出 `reply.repair.started`，Telegram 显示 `正在补全查询结果`
- 补跑后的结果必须二选一：
  - 给出实际结果
  - 明确说明为什么现在拿不到结果
- 如果补跑后仍没有结果，也没有明确失败原因，Telegram 会显示失败提示，而不是把半截进度句当最终答案

## Telegram V2 新增了什么

V2 的重点不是改状态文案，而是把 Telegram 的任务执行方式从“纯内存前台批次”升级为“SQLite 持久化后台任务”。

当前 V2 行为：

- task / input / attempt / poll offset 全部持久化
- 服务重启后会恢复 Telegram 任务状态
- polling 从持久化 `last_update_id + 1` 继续，不再首次直接跳到最新 offset
- 补充消息不再依赖单个 `pendingRestart` 槽位，改为 revision / attempt 语义
- superseded attempt 不会写共享 session/history/memory

## Telegram 补充分类 sidecar

V2 还新增了一个可选 sidecar，用于在“补充当前任务”与“排队为新任务”之间做快速判断。

规则是：

- 先走硬规则
- 只有灰区才调用 sidecar 小模型
- 小模型路径和主 Codex 任务隔离，不干扰主任务
- 低置信、超时、熔断、非法输出时，一律回退到 Telegram 人工二选一

当前默认 sidecar 模型为 `gpt-5.4-mini`，通过显式环境变量配置，不读取 Codex desktop 的 `config.toml`。

## 当前边界

目前仍然不包含：

- Web / Feishu 的持久化后台任务
- 运行中的 steering / 中途引导
- 对主 provider 执行通道的替换

所以 V2 的本质是：

- Telegram 更耐重启
- 长任务更适合后台持续跑
- 补充/排队判断更快

但不是“已经能在原任务运行到一半时，直接改写 Codex 的执行方向”。

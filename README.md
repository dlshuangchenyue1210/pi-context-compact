# 上下文整理与压缩扩展

适用于 Pi 1.5.2 的全局扩展。目录放在 `~/.pi/agent/extensions/context-compact/`，在 Pi 中执行 `/reload` 加载。

## 行为

1. 每次任务开始前、每轮回复及工具结果完成后，检查上下文用量。
2. 默认达到 **60%** 时，只注入 `config.json` 中的提醒，**不直接替换上下文**。若这一轮本来已结束，额外请求一轮让 Agent 处理提醒。
3. Agent 暂停推进任务，自行选择直接下达完整长指令，或更新现有交接文档，不强制创建文件。
4. Agent 单独调用 `compact_context`，在 `resumeInstructions` 中填写完整续跑指令，或仅提供交接文档路径、先读取文档并继续任务的必要指令。不在正文、参数和文档之间重复下达同一指令。交接按当前状态重写，只保留仍有效的信息，不累积旧交接或工作日志。
5. 当前工具批次结束后，在**同一个 session** 内，用交接替换此前全部对话上下文并自动继续；系统提示和工具保留。后续新消息正常累积，再次交接时只保留最新的一份。

旧记录仍保存在原会话文件中，不删除、不新建 session。底层使用 Pi 的上下文检查点（`compaction` 记录）保存替换边界，但不调用原生压缩生成摘要、不保留近期对话，也不额外注入一份恢复指令。恢复后依据续跑指令继续；采用文档交接时，先读取指定文档。

扩展不强制核验文档是否已更新；整理工作和调用时机由 Agent 根据提醒决定。

## 配置

配置分为两级：

1. 插件目录中的 `config.json`：随版本更新的默认配置。
2. `~/.pi/agent/context-compact.json`：可选的用户配置，优先于默认配置，插件不会创建或改写它。实际目录跟随 Pi 的 `PI_CODING_AGENT_DIR` 设置。

用户文件只需填写想覆盖的顶层字段，未填写的继承默认值。`defaultThreshold` 对象和 `modelRules` 数组各自整体替换，不递归合并。例如用户文件只写：

```json
{
  "defaultThreshold": { "tokens": 100000 }
}
```

这会替换默认阈值，不再继承默认的 `percent`。`modelRules: []` 可清空默认模型规则；`enabled: false` 可停用扩展。

修改后执行 `/context-compact reload` 生效；也可用 `/reload`。用户文件在仓库外，无需 Git 忽略规则，也不随插件更新。

完整配置格式：

```json
{
  "enabled": true,
  "defaultThreshold": { "percent": 60 },
  "modelRules": [
    { "modelPattern": "^openai-codex/", "percent": 55 },
    { "modelPattern": "claude", "tokens": 100000 },
    { "modelPattern": "gemini", "percent": 60, "tokens": 300000 }
  ],
  "reminder": "这里填写上下文整理提醒。请保留整理完成后主动调用 compact_context 并填写 resumeInstructions 续跑指令的要求。"
}
```

- `modelPattern`：JavaScript 正则表达式的源字符串，不带 `/…/` 分隔符，忽略大小写，匹配完整的 `provider/modelId`。
- 按数组顺序取**首个命中规则**；该规则整体替代默认阈值，不与默认阈值合并。
- `percent`：大于 0、小于 100 的百分比。
- `tokens`：正整数 token 数。
- 同时填写时，**任一达到**就提醒；未匹配模型使用 `defaultThreshold`。
- JSON 中的正则反斜杠需要转义，如 `"deepseek-v4\\.1"`。
- `reminder` 可以直接修改。每次提醒前会自动附上当前 token 数和占用百分比。
- `enabled: false` 同时关闭提醒和本扩展的上下文替换工具执行，不影响 Pi 自身压缩。
- 合并后的配置无效、用户文件格式错误或无法读取时，停用本扩展并显示错误；用户文件不存在则正常使用默认配置。修好后重载配置。

## 命令与工具

- `/context-compact` 或 `/context-compact status`：查看当前模型、命中阈值、用量、提醒状态及配置位置。
- `/context-compact reload`：重新读取并合并两级配置。
- `compact_context`：Agent 可调用的工具；保留原工具名，`resumeInstructions` 必填，可直接下达完整长指令，或指向已更新的现有交接文档并要求先读取。交接应包含目标、约束、当前状态、必要决策、文件路径、验证结果和下一步；若已完成或等待用户，明确要求说明状态并等待。
- 原 `summaryInstructions` 参数和 `/context-compact run` 内部入口已移除。

## 验证

运行 `node ~/.pi/agent/extensions/context-compact/self-check.mjs`。离线检查两级配置覆盖、重载、用户配置保留、阈值提醒、规则匹配、重复提醒和取消，并用真实 Pi SDK 和模拟模型响应验证上下文替换、自动续跑、多次交接去重、会话身份与旧记录保留，以及重新打开会话后的恢复。不使用真实凭据，不调用外部 API，不修改正式配置。

## 边界

- 每次高水位只提醒一次；只有用量降到阈值以下才重新允许提醒。状态随当前会话分支保存，重载不会重复刷提醒。
- 替换后如果上下文仍高于阈值，不会立即再次提醒，避免循环；阈值需要为系统提示、工具声明和完整交接留出空间。
- 在上下文替换前中止 Agent，会取消待处理的交接；已经保存的替换不会回滚。交接原文仍可从工具调用参数取回。
- 待处理的交接不会在 Pi 重启、扩展重载或会话切换后自动重放；已保存的替换边界随当前会话分支恢复。
- 不修改 `settings.json`，不接管手动 `/compact`，不关闭 Pi 自带的阈值/溢出恢复压缩。本扩展工具本身不调用它们。
- 上下文用量来自 Pi 的统计/估算，不是另行调用 tokenizer。无法取得用量时不提醒。

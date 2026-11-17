# 上下文整理与压缩扩展

适用于 Pi 1.5.2 的全局扩展。目录放在 `~/.pi/agent/extensions/context-compact/`，在 Pi 中执行 `/reload` 加载。

## 行为

1. 每次任务开始前、每轮回复及工具结果完成后，检查上下文用量。
2. 默认达到 **60%** 时，只注入 `config.json` 中的提醒，**不直接压缩**。若这一轮本来已结束，额外请求一轮让 Agent 处理提醒。
3. Agent 暂停推进任务，按需同步已有项目文档，并在会话中整理交接信息。不强制创建文件。
4. Agent 整理完成后，主动单独调用 `compact_context`，传入自己写好的 `resumeInstructions`，可选传入 `summaryInstructions`。
5. 等当前 Agent 运行结束后执行 Pi 原生压缩。成功后，自动注入保存的恢复指令并启动同一会话的下一轮。

扩展不强制核验文档是否已更新；整理工作和调用时机由 Agent 根据提醒决定。恢复指令保存在工具调用参数及结果中，并额外作为摘要要求交给原生压缩。

## 配置

编辑同目录 `config.json`，执行 `/context-compact reload` 生效；也可用 `/reload`。

```json
{
  "enabled": true,
  "defaultThreshold": { "percent": 60 },
  "modelRules": [
    { "modelPattern": "^openai-codex/", "percent": 55 },
    { "modelPattern": "claude", "tokens": 100000 },
    { "modelPattern": "gemini", "percent": 60, "tokens": 300000 }
  ],
  "reminder": "这里填写压缩前提醒。请保留整理完成后主动调用 compact_context 并填写 resumeInstructions 的要求。"
}
```

- `modelPattern`：JavaScript 正则表达式的源字符串，不带 `/…/` 分隔符，忽略大小写，匹配完整的 `provider/modelId`。
- 按数组顺序取**首个命中规则**；该规则整体替代默认阈值，不与默认阈值合并。
- `percent`：大于 0、小于 100 的百分比。
- `tokens`：正整数 token 数。
- 同时填写时，**任一达到**就提醒；未匹配模型使用 `defaultThreshold`。
- JSON 中的正则反斜杠需要转义，如 `"deepseek-v4\\.1"`。
- `reminder` 可以直接修改。每次提醒前会自动附上当前 token 数和占用百分比。
- `enabled: false` 同时关闭提醒和本扩展的压缩工具执行，不影响 Pi 自身压缩。
- 配置无效时停用本扩展并显示错误，修好后重载配置。

## 命令与工具

- `/context-compact` 或 `/context-compact status`：查看当前模型、命中阈值、用量、提醒状态及配置位置。
- `/context-compact reload`：重载配置。
- `compact_context`：Agent 可调用的工具；`resumeInstructions` 必填，`summaryInstructions` 可选。
- `/context-compact run`：工具使用的内部入口，无待处理请求时不做任何事。

## 验证

运行 `node ~/.pi/agent/extensions/context-compact/self-check.mjs`。离线检查阈值提醒、规则匹配、重复提醒、取消和失败分支，并用真实 Pi SDK 和模拟模型响应验证完整的压缩后续跑链路。不使用真实凭据，不调用外部 API，不修改正式配置。

## 边界

- 每次高水位只提醒一次；只有用量降到阈值以下才重新允许提醒。状态随当前会话分支保存，重载不会重复刷提醒。
- 压缩后如果上下文仍高于阈值，不会立即再次提醒，从而避免压缩循环。固定 token 阈值应高于原生压缩保留的近期上下文量（默认约 20000 token，另加系统提示和摘要）。
- 用户中止 Agent 时，不执行尚未开始的压缩。压缩失败或被取消时，不自动继续、不循环重试；恢复指令仍可从工具调用记录取回。
- 运行中的压缩请求不会在 Pi 重启或扩展重载后自动重放。
- 不修改 `settings.json`，不接管手动 `/compact`，不关闭 Pi 自带的阈值/溢出恢复压缩。自动注入恢复指令仅适用于本扩展工具发起的成功压缩。
- 上下文用量来自 Pi 的统计/估算，不是另行调用 tokenizer。无法取得用量时不提醒。

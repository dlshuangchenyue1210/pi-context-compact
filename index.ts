import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Threshold = { percent?: number; tokens?: number };
type Rule = Threshold & { modelPattern: string };
type Config = {
	enabled: boolean;
	defaultThreshold: Threshold;
	modelRules: Rule[];
	reminder: string;
};

const configPath = fileURLToPath(new URL("./config.json", import.meta.url));
const userConfigPath = join(getAgentDir(), "context-compact.json");
const configPaths = `默认配置：${configPath}\n用户配置：${userConfigPath}`;
const stateType = "context-compact-state";
const reminderType = "context-compact-reminder";

function validateThreshold(value: unknown, label: string): asserts value is Threshold {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
	const { percent, tokens } = value as Threshold;
	if (percent === undefined && tokens === undefined) throw new Error(`${label} 至少需要 percent 或 tokens`);
	if (percent !== undefined && (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0 || percent >= 100)) {
		throw new Error(`${label}.percent 必须大于 0 且小于 100`);
	}
	if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0)) {
		throw new Error(`${label}.tokens 必须是正安全整数`);
	}
}

function readConfigFile(path: string) {
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是 JSON 对象`);
	return value;
}

function loadConfig(): Config {
	const defaults = readConfigFile(configPath);
	let overrides = {};
	try {
		overrides = readConfigFile(userConfigPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const config = { ...defaults, ...overrides };
	if (!config || typeof config !== "object" || typeof config.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
	validateThreshold(config.defaultThreshold, "defaultThreshold");
	if (!Array.isArray(config.modelRules)) throw new Error("modelRules 必须是数组");
	for (const [index, rule] of config.modelRules.entries()) {
		validateThreshold(rule, `modelRules[${index}]`);
		if (typeof rule.modelPattern !== "string" || !rule.modelPattern.trim()) throw new Error(`modelRules[${index}] 缺少 modelPattern`);
		new RegExp(rule.modelPattern, "i");
	}
	if (typeof config.reminder !== "string" || !config.reminder.trim()) throw new Error("reminder 不能为空");
	return config;
}

export default function (pi: ExtensionAPI) {
	let config: Config | undefined;
	let reminded = false;
	let pending: string | undefined;

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};
	const reloadConfig = (ctx: ExtensionContext) => {
		try {
			config = loadConfig();
			return true;
		} catch (error) {
			config = undefined;
			notify(ctx, `上下文提醒已停用：${String(error)}\n${configPaths}`, "error");
			return false;
		}
	};
	const threshold = (ctx: ExtensionContext) => {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		return config!.modelRules.find((rule) => new RegExp(rule.modelPattern, "i").test(model)) ?? config!.defaultThreshold;
	};
	const reached = (ctx: ExtensionContext, tokens: number, contextWindow: number) => {
		const limit = threshold(ctx);
		return (limit.tokens !== undefined && tokens >= limit.tokens) ||
			(limit.percent !== undefined && contextWindow > 0 && tokens / contextWindow * 100 >= limit.percent);
	};
	const setReminded = (value: boolean) => {
		if (reminded === value) return;
		reminded = value;
		pi.appendEntry(stateType, { reminded });
	};
	const restore = (ctx: ExtensionContext) => {
		reminded = false;
		pending = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			// Wait for usage to fall below the threshold after compaction to avoid loops.
			if (entry.type === "compaction") reminded = true;
			if (entry.type === "custom" && entry.customType === stateType) {
				reminded = (entry.data as { reminded?: boolean })?.reminded === true;
			}
		}
	};
	const reminder = (ctx: ExtensionContext) => {
		if (!config?.enabled || pending) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null) return;
		if (!reached(ctx, usage.tokens, usage.contextWindow)) {
			setReminded(false);
			return;
		}
		if (reminded) return;
		setReminded(true);
		const percent = usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow * 100).toFixed(1) + "%" : "未知";
		return {
			customType: reminderType,
			content: `上下文已达到整理阈值：${usage.tokens} token，占用 ${percent}。\n\n${config.reminder}`,
			display: true,
		};
	};

	pi.on("session_start", (_event, ctx) => {
		reloadConfig(ctx);
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		pending = undefined;
	});
	pi.on("session_compact", () => { reminded = true; });
	pi.on("before_agent_start", (_event, ctx) => {
		const message = reminder(ctx);
		if (message) return { message };
	});
	pi.on("turn_end", (event, ctx) => {
		if (event.outcome !== "completed" || ctx.signal?.aborted) {
			pending = undefined;
			return;
		}
		if (pending) {
			const instructions = pending;
			pending = undefined;
			reminded = true;
			return {
				entries: [...event.entries, {
					type: "compaction" as const,
					summary: instructions,
					// Keep the handoff, but none of the preceding conversation.
					firstKeptEntryId: null,
				}],
				continue: true,
			};
		}
		const message = reminder(ctx);
		if (message) return {
			entries: [...event.entries, { type: "custom_message" as const, ...message }],
			continue: true,
		};
	});

	pi.registerTool({
		name: "compact_context",
		label: "交接完成，替换上下文并继续",
		description: "将续跑指令写入 resumeInstructions，替换旧上下文并继续。不要在正文和工具参数中重复下达同一指令。请单独调用，不要与其他工具并行调用。",
		parameters: Type.Object({
			resumeInstructions: Type.String({ minLength: 1, description: "自行选择直接写完整长指令，或更新现有交接文档后只写文档路径、先读取文档并继续任务的必要指令，不重复文档内容。交接内容应覆盖目标、约束、当前状态、必要决策、文件路径、验证结果和下一步，只保留仍有效的信息；若已完成或等待用户，明确要求说明状态并等待，不得自行扩大任务范围。" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!config?.enabled) throw new Error("上下文整理扩展已停用，请检查配置。");
			if (pending) throw new Error("已有上下文替换请求正在等待执行。");
			if (signal?.aborted) throw new Error("请求已取消。");
			if (!params.resumeInstructions.trim()) throw new Error("resumeInstructions 不能为空白。");
			pending = params.resumeInstructions;
			notify(ctx, "交接已保存，当前工具批次结束后替换上下文。");
			return {
				content: [{ type: "text" as const, text: "交接已保存，当前工具批次结束后替换旧上下文并继续。" }],
				details: {},
				terminate: true,
			};
		},
	});

	pi.on("agent_settled", () => { pending = undefined; });
	pi.registerCommand("context-compact", {
		description: "上下文提醒：status 查看状态，reload 重载配置",
		handler: async (args, ctx) => {
			if (args.trim() === "reload") {
				if (reloadConfig(ctx)) notify(ctx, `配置已重载。\n${configPaths}`);
				return;
			}
			const usage = ctx.getContextUsage();
			notify(ctx, `上下文提醒：${config?.enabled ? "启用" : "停用"}\n模型：${ctx.model?.provider}/${ctx.model?.id}\n阈值：${config ? JSON.stringify(threshold(ctx)) : "配置无效"}\n用量：${usage?.tokens ?? "未知"} token\n本次高水位已提醒：${reminded}\n${configPaths}`);
		},
	});
}

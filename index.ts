import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Threshold = { percent?: number; tokens?: number };
type Rule = Threshold & { modelPattern: string };
type Config = {
	enabled: boolean;
	defaultThreshold: Threshold;
	modelRules: Rule[];
	reminder: string;
};
type Request = { resumeInstructions: string; summaryInstructions?: string };

const configPath = fileURLToPath(new URL("./config.json", import.meta.url));
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

function loadConfig(): Config {
	const config = JSON.parse(readFileSync(configPath, "utf8"));
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
	let pending: Request | undefined;
	let compacting = false;
	let active = true;

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};
	const reloadConfig = (ctx: ExtensionContext) => {
		try {
			config = loadConfig();
			return true;
		} catch (error) {
			config = undefined;
			notify(ctx, `上下文提醒已停用：${String(error)}\n配置：${configPath}`, "error");
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
		if (!config?.enabled || pending || compacting) return;
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
		active = true;
		reloadConfig(ctx);
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		active = false;
		pending = undefined;
	});
	pi.on("session_compact", () => { reminded = true; });
	pi.on("before_agent_start", (_event, ctx) => {
		const message = reminder(ctx);
		if (message) return { message };
	});
	pi.on("turn_end", (event, ctx) => {
		if (event.outcome !== "completed") return;
		const message = reminder(ctx);
		if (message) return {
			entries: [...event.entries, { type: "custom_message" as const, ...message }],
			continue: true,
		};
	});

	pi.registerTool({
		name: "compact_context",
		label: "整理完成，压缩并继续",
		description: "完成上下文整理后主动调用。先在会话中记录交接信息，按需要更新现有项目文档（不强制创建文件），再将压缩后应执行的具体指令写入 resumeInstructions。工具批次结束后压缩，成功后自动注入该指令并继续。请单独调用，不要与其他工具并行调用。",
		parameters: Type.Object({
			resumeInstructions: Type.String({ minLength: 1, description: "压缩后注入的完整恢复指令：当前目标、约束、状态、必要文件路径、下一步；若等待用户则明确说明，不得自行扩大任务范围。" }),
			summaryInstructions: Type.Optional(Type.String({ description: "可选：额外的压缩摘要要求。" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!config?.enabled) throw new Error("上下文压缩扩展已停用，请检查配置。");
			if (pending || compacting) throw new Error("已有压缩请求正在等待或执行。");
			if (signal?.aborted) throw new Error("请求已取消。");
			if (!params.resumeInstructions.trim()) throw new Error("resumeInstructions 不能为空白。");
			pending = { resumeInstructions: params.resumeInstructions, summaryInstructions: params.summaryInstructions };
			notify(ctx, "整理已完成，当前工具批次结束后压缩。");
			return {
				content: [{ type: "text" as const, text: `已保存恢复指令，压缩成功后自动注入：\n\n${params.resumeInstructions}` }],
				details: { ...pending },
				terminate: true,
			};
		},
	});

	// Dispatch through a command after settling; compact() aborts/waits for idle.
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted) {
			pending = undefined;
			return;
		}
		if (pending && !compacting && !ctx.hasPendingMessages()) {
			pi.sendUserMessage("/context-compact run", { expandPromptTemplates: true });
		}
	});
	pi.registerCommand("context-compact", {
		description: "上下文提醒：status 查看状态，reload 重载配置；run 为工具内部入口",
		handler: async (args, ctx) => {
			if (args.trim() === "reload") {
				if (reloadConfig(ctx)) notify(ctx, `配置已重载：${configPath}`);
				return;
			}
			if (args.trim() !== "run") {
				const usage = ctx.getContextUsage();
				notify(ctx, `上下文提醒：${config?.enabled ? "启用" : "停用"}\n模型：${ctx.model?.provider}/${ctx.model?.id}\n阈值：${config ? JSON.stringify(threshold(ctx)) : "配置无效"}\n用量：${usage?.tokens ?? "未知"} token\n本次高水位已提醒：${reminded}\n配置：${configPath}`);
				return;
			}
			if (!pending || compacting) return;
			await ctx.waitForIdle();
			if (!active || !pending) return;
			const request = pending;
			pending = undefined;
			compacting = true;
			notify(ctx, "正在压缩上下文……");
			await new Promise<void>((resolve) => {
				ctx.compact({
					customInstructions: [
						"保留用户目标、约束、已完成与未完成事项、关键决策、文件路径及验证结果。以下是 Agent 整理的恢复指令，请保留其必要上下文：",
						request.resumeInstructions,
						request.summaryInstructions,
					].filter(Boolean).join("\n\n"),
					onComplete: () => {
						compacting = false;
						if (active) {
							notify(ctx, "上下文压缩完成，正在恢复任务。");
							pi.sendMessage({
								customType: "context-compact-resume",
								content: `上下文压缩已完成。请依据摘要和以下恢复指令继续；若任务已完成或需要用户决定，则说明状态并等待，不要另起任务。\n\n${request.resumeInstructions}`,
								display: true,
							}, { triggerTurn: true, deliverAs: "followUp" });
						}
						resolve();
					},
					onError: (error) => {
						compacting = false;
						if (active) notify(ctx, `压缩失败或取消，未自动继续：${error.message}。恢复指令仍保留在工具调用记录中。`, "error");
						resolve();
					},
				});
			});
		},
	});
}

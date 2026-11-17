// Run with: node ~/.pi/agent/extensions/context-compact/self-check.mjs
// Offline: uses disposable configuration and simulated model responses, never real credentials.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const install = process.env.PI_MANAGED_INSTALL_ROOT ?? resolve(here, "../../install");
const version = (await readFile(join(install, "current-version"), "utf8")).trim();
const modules = join(install, "releases", version, "node_modules/@earendil-works");
const sdk = await import(pathToFileURL(join(modules, "pi-coding-agent/dist/index.js")));
const { loadExtensions, loadExtensionFromFactory } = await import(pathToFileURL(join(modules, "pi-coding-agent/dist/core/extensions/loader.js")));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(modules, "pi-ai/dist/utils/event-stream.js")));
const temp = await mkdtemp(join(tmpdir(), "pi-context-compact-check-"));
const config = JSON.parse(await readFile(join(here, "config.json"), "utf8"));
const example = { ...config, enabled: true, defaultThreshold: { percent: 60 }, modelRules: [] };
const extensionPath = join(temp, "index.ts");
await copyFile(join(here, "index.ts"), extensionPath);

async function harness(settings = example) {
	await writeFile(join(temp, "config.json"), JSON.stringify(settings));
	const loaded = await loadExtensions([extensionPath], temp);
	assert.deepEqual(loaded.errors, []);
	const ext = loaded.extensions[0];
	const branch = [];
	const sent = [];
	const commands = [];
	const compactions = [];
	let tokens = 59000;
	loaded.runtime.appendEntry = (customType, data) => branch.push({ type: "custom", customType, data });
	loaded.runtime.sendMessage = (message, options) => sent.push({ message, options });
	loaded.runtime.sendUserMessage = (text, options) => commands.push({ text, options });
	const ctx = {
		cwd: temp, hasUI: false, model: { provider: "test", id: "demo" },
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ tokens, contextWindow: 100000 }),
		hasPendingMessages: () => false, waitForIdle: async () => {},
		compact: (options) => { compactions.push(options); options.onComplete({}); },
	};
	const emit = async (name, event = {}) => {
		let result;
		for (const handler of ext.handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	const execute = (resumeInstructions = "继续验证公开接口；不要增加功能。") =>
		ext.tools.get("compact_context").definition.execute("test-call", { resumeInstructions }, undefined, undefined, ctx);
	const run = () => ext.commands.get("context-compact").handler("run", ctx);
	await emit("session_start");
	return { ctx, branch, sent, commands, compactions, emit, execute, run, setTokens: (value) => { tokens = value; } };
}

try {
	const h = await harness();
	assert.equal(await h.emit("before_agent_start"), undefined, "below threshold: no reminder");
	h.setTokens(60000);
	assert.ok((await h.emit("before_agent_start")).message.content.includes("compact_context"));
	assert.equal(h.compactions.length, 0, "threshold must NEVER compact automatically");
	assert.equal(await h.emit("turn_end", { outcome: "completed", entries: [] }), undefined, "no duplicate reminder");
	await h.emit("session_start");
	assert.equal(await h.emit("before_agent_start"), undefined, "reload preserves reminder state");
	h.setTokens(59000);
	await h.emit("before_agent_start");
	h.setTokens(60000);
	const boundary = await h.emit("turn_end", { outcome: "completed", entries: [] });
	assert.equal(boundary.continue, true, "a final response still gives the Agent one turn to handle reminder");
	assert.equal(boundary.entries[0].type, "custom_message");
	const result = await h.execute();
	assert.equal(result.terminate, true);
	assert.equal(h.compactions.length, 0, "tool must wait until the run settles");
	await h.emit("agent_settled", { aborted: false });
	assert.deepEqual(h.commands[0], { text: "/context-compact run", options: { expandPromptTemplates: true } });
	await h.run();
	assert.equal(h.compactions.length, 1);
	assert.ok(h.compactions[0].customInstructions.includes(result.details.resumeInstructions));
	assert.ok(h.sent[0].message.content.includes(result.details.resumeInstructions));
	assert.equal(h.sent[0].options.triggerTurn, true);
	await h.emit("session_compact");
	assert.equal(await h.emit("before_agent_start"), undefined, "still-high usage after compaction must not loop");

	const cancelled = await harness();
	await cancelled.execute();
	await cancelled.emit("agent_settled", { aborted: true });
	await cancelled.run();
	assert.equal(cancelled.compactions.length, 0, "abort cancels pending compaction");
	const failed = await harness();
	failed.ctx.compact = (options) => options.onError(new Error("simulated cancellation"));
	await failed.execute();
	await failed.run();
	assert.equal(failed.sent.length, 0, "failed compaction must not wake Agent");

	const rules = await harness({ ...example, modelRules: [
		{ modelPattern: "^TEST/", tokens: 30000 },
		{ modelPattern: "demo", percent: 10 },
	] });
	rules.setTokens(29999);
	assert.equal(await rules.emit("before_agent_start"), undefined, "first match wins without fallback-percent merge");
	rules.setTokens(30000);
	assert.ok(await rules.emit("before_agent_start"));
	const either = await harness({ ...example, modelRules: [{ modelPattern: "test", percent: 80, tokens: 40000 }] });
	either.setTokens(40000);
	assert.ok(await either.emit("before_agent_start"), "either configured limit can trigger");
	const unknown = await harness();
	unknown.setTokens(null);
	assert.equal(await unknown.emit("before_agent_start"), undefined);
	const invalid = await harness({ ...example, modelRules: [{ modelPattern: "[", percent: 60 }] });
	invalid.setTokens(90000);
	assert.equal(await invalid.emit("before_agent_start"), undefined, "invalid regex disables extension");
	await assert.rejects(invalid.execute());
	const disabled = await harness({ ...example, enabled: false });
	disabled.setTokens(90000);
	assert.equal(await disabled.emit("before_agent_start"), undefined);
	await assert.rejects(disabled.execute());
	console.log("PASS: threshold-only reminder, dedup/reload, rearm, model rules, unknown usage, disabled/invalid config, cancellation, success/failure continuation");

	// Verify scheduling with the real Pi SDK, not only handler mocks.
	await writeFile(join(temp, "config.json"), JSON.stringify(example));
	const loaded = await loadExtensions([extensionPath], temp);
	let compactCount = 0;
	const summaryHook = await loadExtensionFromFactory((pi) => {
		pi.on("session_before_compact", (event) => {
			compactCount++;
			assert.ok(event.customInstructions.includes("RESUME_SENTINEL"));
			return { compaction: {
				summary: "离线验证摘要：继续验证，不增加功能。",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			} };
		});
	}, temp, sdk.createEventBus(), loaded.runtime);
	loaded.extensions.push(summaryHook);
	const resourceLoader = {
		getExtensions: () => loaded,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Offline extension verification.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
		extendResources: () => {}, reload: async () => {},
	};
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(temp, "auth.json"), modelsPath: join(temp, "models.json") });
	await modelRuntime.setRuntimeApiKey("openai", "offline-test-not-a-real-key");
	const model = { provider: "openai", id: "gpt-4o", name: "Offline model", api: "openai-completions", baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const { session } = await sdk.createAgentSession({
		cwd: temp, agentDir: temp, resourceLoader, modelRuntime, model, thinkingLevel: "off",
		tools: ["compact_context"], sessionManager: sdk.SessionManager.inMemory(temp),
		settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } }),
	});
	try {
		let calls = 0;
		const errors = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		session.agent.streamFunction = (_model, context) => {
			calls++;
			assert.ok(calls <= 3, "must not enter a continuation loop");
			if (calls === 2) assert.ok(JSON.stringify(context.messages).includes("上下文已达到整理阈值"));
			if (calls === 3) assert.ok(JSON.stringify(context.messages).includes("RESUME_SENTINEL"));
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: calls === 2 ? [{ type: "toolCall", id: "compact-check", name: "compact_context", arguments: { resumeInstructions: "RESUME_SENTINEL：继续验证，不增加功能。" } }] : [{ type: "text", text: calls === 1 ? "当前进展已同步。" : "恢复任务完成。" }],
				stopReason: calls === 2 ? "toolUse" : "stop",
				usage: { input: calls <= 2 ? 65000 : 12000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: calls <= 2 ? 65050 : 12050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		};
		await Promise.race([
			session.prompt("执行离线验证任务。"),
			new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("SDK scheduling timeout")), 15000); timer.unref(); }),
		]);
		await session.waitForIdle();
		assert.equal(calls, 3, "initial response -> reminder response/tool -> post-compaction response");
		assert.equal(compactCount, 1);
		assert.deepEqual(errors, []);
		assert.equal(session.getLastAssistantText(), "恢复任务完成。");
		console.log("PASS: real Pi SDK: reminder -> Agent tool -> settle -> native compaction -> injected instruction -> automatic continuation (3 model requests, 1 compaction)");
	} finally {
		session.dispose();
	}
} finally {
	await rm(temp, { recursive: true, force: true });
}

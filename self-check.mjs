// Run with: node ~/.pi/agent/extensions/context-compact/self-check.mjs
// Offline: uses disposable configuration and simulated model responses, never real credentials.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
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
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
const userConfigPath = join(process.env.PI_CODING_AGENT_DIR, "context-compact.json");
const config = JSON.parse(await readFile(join(here, "config.json"), "utf8"));
const example = { ...config, enabled: true, defaultThreshold: { percent: 60 }, modelRules: [] };
const extensionPath = join(temp, "index.ts");
await copyFile(join(here, "index.ts"), extensionPath);

async function harness(settings = example, overrides) {
	await writeFile(join(temp, "config.json"), JSON.stringify(settings));
	if (overrides === undefined) await rm(userConfigPath, { force: true });
	else await writeFile(userConfigPath, JSON.stringify(overrides));
	const loaded = await loadExtensions([extensionPath], temp);
	assert.deepEqual(loaded.errors, []);
	const ext = loaded.extensions[0];
	const branch = [];
	let tokens = 59000;
	loaded.runtime.appendEntry = (customType, data) => branch.push({ type: "custom", customType, data });
	const ctx = {
		cwd: temp, hasUI: false, model: { provider: "test", id: "demo" },
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ tokens, contextWindow: 100000 }),
		compact: () => assert.fail("must not invoke native compaction"),
	};
	const emit = async (name, event = {}) => {
		let result;
		for (const handler of ext.handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	const execute = (resumeInstructions = "继续验证公开接口；不要增加功能。", signal) =>
		ext.tools.get("compact_context").definition.execute("test-call", { resumeInstructions }, signal, undefined, ctx);
	await emit("session_start");
	return { emit, execute, reload: () => ext.commands.get("context-compact").handler("reload", ctx), setTokens: (value) => { tokens = value; } };
}

try {
	const h = await harness();
	assert.equal(await h.emit("before_agent_start"), undefined, "below threshold: no reminder");
	await assert.rejects(readFile(userConfigPath), { code: "ENOENT" }, "must not create a user config automatically");
	h.setTokens(60000);
	assert.ok((await h.emit("before_agent_start")).message.content.includes("compact_context"));
	assert.equal(await h.emit("turn_end", { outcome: "completed", entries: [] }), undefined, "no duplicate reminder");
	await h.emit("session_start");
	assert.equal(await h.emit("before_agent_start"), undefined, "reload preserves reminder state");
	h.setTokens(59000);
	await h.emit("before_agent_start");
	h.setTokens(60000);
	const boundary = await h.emit("turn_end", { outcome: "completed", entries: [] });
	assert.equal(boundary.continue, true, "a final response still gives the Agent one turn to handle reminder");
	assert.equal(boundary.entries[0].type, "custom_message");
	await assert.rejects(h.execute(" \n"), /不能为空白/);
	await assert.rejects(h.execute(undefined, AbortSignal.abort()), /已取消/);
	await h.execute();
	await assert.rejects(h.execute(), /已有/, "duplicate requests must be rejected");
	assert.equal(await h.emit("turn_end", { outcome: "aborted", entries: [] }), undefined, "abort must not replace context");
	await assert.doesNotReject(h.execute(), "abort must clear the pending request");
	await h.emit("agent_settled", { aborted: true });
	await assert.doesNotReject(h.execute(), "a late abort must also clear pending work");

	const failed = await harness();
	await failed.execute();
	assert.equal(await failed.emit("turn_end", { outcome: "error", entries: [] }), undefined);
	await assert.doesNotReject(failed.execute(), "errors must discard pending work");
	const restarted = await harness();
	await restarted.execute();
	await restarted.emit("session_start");
	assert.equal(await restarted.emit("turn_end", { outcome: "completed", entries: [] }), undefined, "reload must not replay pending work");

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
	console.log("PASS: threshold reminders, dedup/reload, rearm, model rules, unknown usage, disabled/invalid config, input validation and cancellation");

	const defaults = { ...example, defaultThreshold: { percent: 10, tokens: 80000 }, modelRules: [{ modelPattern: "test", tokens: 1 }], reminder: "DEFAULT_REMINDER" };
	const overrides = { defaultThreshold: { tokens: 30000 }, modelRules: [] };
	const user = await harness(defaults, overrides);
	user.setTokens(29999);
	assert.equal(await user.emit("before_agent_start"), undefined, "user threshold and model rules must replace whole fields");
	user.setTokens(30000);
	assert.ok((await user.emit("before_agent_start")).message.content.includes("DEFAULT_REMINDER"), "omitted fields inherit defaults");
	const userFileBefore = await readFile(userConfigPath, "utf8");
	await writeFile(join(temp, "config.json"), JSON.stringify({ ...defaults, reminder: "NEW_DEFAULT_REMINDER" }));
	await user.reload();
	user.setTokens(29999);
	await user.emit("before_agent_start");
	user.setTokens(30000);
	assert.ok((await user.emit("before_agent_start")).message.content.includes("NEW_DEFAULT_REMINDER"), "default updates apply without losing user overrides");
	assert.equal(await readFile(userConfigPath, "utf8"), userFileBefore, "loading and reloading must never rewrite user config");
	await writeFile(userConfigPath, JSON.stringify({ ...overrides, reminder: "USER_REMINDER" }));
	await user.reload();
	user.setTokens(29999);
	await user.emit("before_agent_start");
	user.setTokens(30000);
	assert.ok((await user.emit("before_agent_start")).message.content.includes("USER_REMINDER"), "user reminder overrides defaults after reload");
	const userDisabled = await harness(example, { enabled: false });
	userDisabled.setTokens(90000);
	assert.equal(await userDisabled.emit("before_agent_start"), undefined);
	await assert.rejects(userDisabled.execute(), /已停用/);
	for (const invalidOverride of [null, { defaultThreshold: { percent: 0 } }]) {
		const invalidUser = await harness(example, invalidOverride);
		invalidUser.setTokens(90000);
		assert.equal(await invalidUser.emit("before_agent_start"), undefined);
		await assert.rejects(invalidUser.execute(), /已停用/, "invalid user config must not silently fall back to defaults");
	}
	const malformedUser = await harness();
	await writeFile(userConfigPath, "{");
	await malformedUser.reload();
	await assert.rejects(malformedUser.execute(), /已停用/);
	console.log("PASS: optional user config, top-level override, inherited defaults, reload, update preservation and invalid user config");

	// Verify scheduling with the real Pi SDK, not only handler mocks.
	await rm(userConfigPath, { force: true });
	await writeFile(join(temp, "config.json"), JSON.stringify(example));
	const loaded = await loadExtensions([extensionPath], temp);
	let nativeCompactions = 0;
	let sessionStarts = 0;
	let queuedMessage = false;
	const observer = await loadExtensionFromFactory((pi) => {
		pi.on("session_start", () => { sessionStarts++; });
		pi.on("tool_result", (event) => {
			if (event.toolName === "compact_context" && !queuedMessage) {
				queuedMessage = true;
				pi.sendUserMessage("QUEUED_USER_MESSAGE", { deliverAs: "steer" });
			}
		});
		pi.on("session_before_compact", () => {
			nativeCompactions++;
			return { cancel: true }; // Never allow an unexpected compaction to call an external API.
		});
	}, temp, sdk.createEventBus(), loaded.runtime);
	loaded.extensions.push(observer);
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
	const manager = sdk.SessionManager.create(temp, join(temp, "sessions"));
	const originalId = manager.getSessionId();
	const originalFile = manager.getSessionFile();
	const { session } = await sdk.createAgentSession({
		cwd: temp, agentDir: temp, resourceLoader, modelRuntime, model, thinkingLevel: "off",
		tools: ["compact_context"], sessionManager: manager,
		settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});
	try {
		let calls = 0;
		const errors = [];
		const handoffs = ["RESUME_ONE：继续验证，不增加功能。", "RESUME_TWO：已完成，说明状态并等待用户。"];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		session.agent.streamFunction = (_model, context) => {
			calls++;
			assert.ok(calls <= 7, "must not enter a continuation loop");
			const visible = JSON.stringify(context.messages);
			assert.ok(visible.includes("Offline extension verification."), "system prompt must survive");
			assert.ok(JSON.stringify(context).includes("compact_context"), "tool declaration must survive");
			if (calls === 2 || calls === 5) assert.ok(visible.includes("上下文已达到整理阈值"));
			if (calls === 3) assert.ok(visible.includes("QUEUED_USER_MESSAGE"), "new queued user input must survive the reset");
			if (calls === 3 || calls === 6 || calls === 7) {
				const handoff = calls === 3 ? handoffs[0] : handoffs[1];
				assert.equal(visible.split(handoff).length - 1, 1, "only one handoff copy is sent");
				assert.ok(!visible.includes("OLD_HISTORY_ONE"), "old user messages must not be sent");
				assert.ok(!visible.includes("OLD_PROGRESS"), "old assistant messages must not be sent");
				assert.ok(!visible.includes("上下文已达到整理阈值"), "old reminders must not be sent");
				assert.ok(!context.messages.some((message) => message.role === "toolResult"), "old tool results must not be sent");
				if (calls !== 3) {
					assert.ok(!visible.includes("RESUME_ONE"), "the previous handoff must not accumulate");
					assert.ok(!visible.includes("OLD_HISTORY_TWO"));
				}
			}
			const handingOff = calls === 2 || calls === 5;
			const highUsage = calls === 1 || calls === 2 || calls === 4 || calls === 5;
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: handingOff ? [{ type: "toolCall", id: `handoff-${calls}`, name: "compact_context", arguments: { resumeInstructions: handoffs[calls === 2 ? 0 : 1] } }] : [{ type: "text", text: highUsage ? "OLD_PROGRESS" : "交接后续跑完成。" }],
				stopReason: handingOff ? "toolUse" : "stop",
				usage: { input: highUsage ? 65000 : 12000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: highUsage ? 65050 : 12050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		};
		const prompt = async (text) => {
			await Promise.race([
				session.prompt(text),
				new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("SDK scheduling timeout")), 15000); timer.unref(); }),
			]);
			await session.waitForIdle();
			assert.equal(manager.getSessionId(), originalId, "must keep the same session identity");
			assert.equal(manager.getSessionFile(), originalFile, "must keep the same session file");
		};
		await prompt("OLD_HISTORY_ONE");
		assert.equal(calls, 3, "initial response -> reminder/tool -> automatic continuation");
		await prompt("OLD_HISTORY_TWO");
		assert.equal(calls, 6, "usage below threshold must rearm the reminder for the next handoff");
		await prompt("后续新消息仍应正常工作。");
		assert.equal(calls, 7);
		assert.equal(nativeCompactions, 0, "must not run native summarization");
		assert.equal(sessionStarts, 1, "must not create a replacement session");
		assert.deepEqual(errors, []);
		const rawHistory = JSON.stringify(manager.getEntries());
		assert.ok(rawHistory.includes("OLD_HISTORY_ONE"), "old records must remain available");
		assert.ok(rawHistory.includes("OLD_HISTORY_TWO"));
		const reopened = sdk.SessionManager.open(originalFile);
		const restored = JSON.stringify(reopened.buildSessionProjection().messages);
		assert.equal(reopened.getSessionId(), originalId);
		assert.ok(restored.includes(handoffs[1]), "latest handoff survives reopening");
		assert.ok(!restored.includes("RESUME_ONE"));
		assert.ok(!restored.includes("OLD_HISTORY"));
		console.log("PASS: real Pi SDK: same-session context replacement, single handoff, automatic continuation, repeated reset, queued user input preserved, old history retained and reopen persistence (7 model requests, 0 native summaries)");
	} finally {
		session.dispose();
	}
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(temp, { recursive: true, force: true });
}

import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, createAssistantMessageEventStream, type AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createExtensionCommandContext,
	createExtensionRegistrationPi,
	createExtensionTestContext,
	createTestToolInfo,
	makeAssistantMessage,
	makeContext,
	makeHarnessModel,
	makeModel,
	makeProviderModelConfig,
} from "./helpers/pi-harness.js";
import {
	createExtensionPi,
	resetIndexExtensionTestState,
	cursorPiToolBridgeTestUtils,
} from "./helpers/index-extension-test-kit.js";

vi.mock("../src/model-discovery.js", () => ({
	fetchCursorDynamicModels: vi.fn(),
	getCursorFallbackModels: vi.fn(),
	getCursorModelMetadata: vi.fn(),
}));

vi.mock("../src/cursor-provider.js", () => ({
	streamCursor: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { fetchCursorDynamicModels, getCursorFallbackModels } from "../src/model-discovery.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { streamCursor } from "../src/cursor-provider.js";
import { streamCursorLazy } from "../src/cursor-provider-lazy.js";
import { buildCursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge.js";
import { CURSOR_SDK_PROVIDER_ID } from "../src/cursor-model.js";
import {
	CURSOR_ASK_QUESTION_BLOCKED_EVENT,
	CURSOR_ASK_QUESTION_TOOL_NAME,
	resolveCursorAskQuestionEnabled,
} from "../src/cursor-question-tool.js";
import { CURSOR_ACTIVATE_SKILL_TOOL_NAME } from "../src/cursor-skill-tool.js";
import { __testUtils as cursorSdkProcessErrorGuardTestUtils } from "../src/cursor-sdk-process-error-guard.js";

const mockedDiscover = getCursorFallbackModels as Mock<typeof getCursorFallbackModels>;
const mockedFetchDynamic = fetchCursorDynamicModels as Mock<typeof fetchCursorDynamicModels>;
const mockedStreamCursor = streamCursor as Mock<typeof streamCursor>;

describe("extension registration and discovery", () => {
	beforeEach(resetIndexExtensionTestState);

	it("keeps one process error guard for the active session lifecycle", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		const originalEmit = process.emit;
		await extensionFactory(pi);

		expect(cursorSdkProcessErrorGuardTestUtils.activeSessionCount()).toBe(0);
		await pi.runSessionStart();
		expect(cursorSdkProcessErrorGuardTestUtils.activeSessionCount()).toBe(1);
		expect(process.emit).not.toBe(originalEmit);
		await pi.runSessionStart({}, {});
		expect(cursorSdkProcessErrorGuardTestUtils.activeSessionCount()).toBe(1);
		await pi.runSessionShutdown({});
		expect(cursorSdkProcessErrorGuardTestUtils.activeSessionCount()).toBe(0);
		expect(process.emit).toBe(originalEmit);
		await pi.runSessionShutdown({});
		expect(cursorSdkProcessErrorGuardTestUtils.activeSessionCount()).toBe(0);
	});

	it("registers Cursor runtime controls and one provider with correct fields", async () => {
		const mockModels = [makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" })];
		mockedDiscover.mockResolvedValueOnce(mockModels);

		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-no-fast",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-mode",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-runtime",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-repo",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-branch",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-context",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-direct-push",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-auto-create-pr",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-skip-reviewer-request",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-allow-local-state",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-env",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-env-from-files",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-env-type",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-cloud-env-name",
			expect.objectContaining({ type: "string", default: "" }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-auto-review",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-sandbox",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-local-resume",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerFlag).toHaveBeenCalledWith(
			"cursor-no-local-resume",
			expect.objectContaining({ type: "boolean", default: false }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-fast",
			expect.objectContaining({ description: expect.stringContaining("Toggle Cursor fast") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-mode",
			expect.objectContaining({ description: expect.stringContaining("Set Cursor SDK conversation mode") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-runtime",
			expect.objectContaining({ description: expect.stringContaining("Set Cursor runtime") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-tools",
			expect.objectContaining({ description: expect.stringContaining("Show live Cursor tool surfaces") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-http",
			expect.objectContaining({ description: expect.stringContaining("Toggle Cursor SDK HTTP/1.1") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-cloud",
			expect.objectContaining({ description: expect.stringContaining("recorded Cursor cloud agents") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-local-resume-cleanup",
			expect.objectContaining({ description: expect.stringContaining("superseded local Cursor SDK agents") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-refresh-models",
			expect.objectContaining({ description: expect.stringContaining("Refresh the live Cursor SDK model catalog") }),
		);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"cursor-refresh-config",
			expect.objectContaining({ description: expect.stringContaining("Refresh filesystem Cursor config") }),
		);
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		expect(pi._tools.map((tool) => tool.name)).toEqual([
			CURSOR_ASK_QUESTION_TOOL_NAME,
			CURSOR_ACTIVATE_SKILL_TOOL_NAME,
			"cursor",
		]);
		// OMP's ToolDefinition has no promptSnippet/promptGuidelines fields.
		const askTool = pi._tools.find((tool) => tool.name === CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(Object.hasOwn(askTool ?? {}, "promptSnippet")).toBe(false);
		const skillTool = pi._tools.find((tool) => tool.name === CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		expect(Object.hasOwn(skillTool ?? {}, "promptSnippet")).toBe(false);
		const replayTool = pi._tools.find((tool) => tool.name === "cursor");
		expect(Object.hasOwn(replayTool ?? {}, "promptSnippet")).toBe(false);
		expect(Object.hasOwn(replayTool ?? {}, "promptGuidelines")).toBe(false);
		expect(pi.setActiveTools).toHaveBeenCalledWith([
			"read",
			"bash",
			"edit",
			"write",
			"cursor",
			CURSOR_ASK_QUESTION_TOOL_NAME,
		]);
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_start", expect.any(Function));
		// OMP has no model_select event; the port must NOT register it.
		expect(pi.on).not.toHaveBeenCalledWith("model_select", expect.any(Function));
		expect(mockedDiscover).toHaveBeenCalledOnce();
		expect(pi.registerProvider).toHaveBeenCalledOnce();

		const [call] = pi._registered;
		expect(call.name).toBe(CURSOR_SDK_PROVIDER_ID);
		// OMP's ProviderConfig has no name field.
		expect((call.config as { name?: string }).name).toBeUndefined();
		expect(call.config.apiKey).toBeUndefined();
		expect(call.config.oauth?.name).toBe("Cursor SDK API key");
		expect(call.config.api).toBe("cursor-sdk");
		expect(call.config.fetchDynamicModels).not.toBe(fetchCursorDynamicModels);
		expect(call.config.models).toBeUndefined();
		mockedFetchDynamic.mockResolvedValueOnce([]);
		await expect(call.config.fetchDynamicModels?.(undefined)).resolves.toBe(mockModels);
		expect(call.config.streamSimple).toBe(streamCursorLazy);
	});

	it("routes fallback discovery through OMP's native extended-context policy", async () => {
		const fallbackModels = [{
			...makeProviderModelConfig("gpt-5.5", {
				name: "GPT-5.5",
				contextWindow: 1_000_000,
			}),
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				longContext: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					inputThreshold: 272_000,
				},
			},
		}];
		mockedDiscover.mockResolvedValueOnce(fallbackModels);
		mockedFetchDynamic.mockResolvedValue([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const registration = pi._registered[0];
		if (!registration) throw new Error("Expected cursor-sdk provider registration");

		const tmpModelCacheDir = mkdtempSync(join(tmpdir(), "cursor-sdk-model-policy-"));
		const authStorage = await AuthStorage.create(":memory:");
		const nativeSettings = Settings.isolated();
		nativeSettings.set("extendedContext", false);
		try {
			const registry = new ModelRegistry(authStorage, undefined, {
				ignoreLocalModelConfig: true,
				settings: nativeSettings,
				cacheDbPath: join(tmpModelCacheDir, "models.db"),
			});
			registry.registerProvider(
				registration.name,
				registration.config,
				"cursor-sdk-contract-test",
			);

			expect(registry.find(CURSOR_SDK_PROVIDER_ID, "gpt-5.5")).toBeUndefined();
			await registry.refreshRuntimeProviders("online");

			expect(mockedFetchDynamic).toHaveBeenCalledWith(undefined);
			expect(registry.find(CURSOR_SDK_PROVIDER_ID, "gpt-5.5")?.contextWindow).toBe(272_000);

			nativeSettings.set("extendedContext", true);
			await registry.reapplyModelPolicies();
			expect(registry.find(CURSOR_SDK_PROVIDER_ID, "gpt-5.5")?.contextWindow).toBe(1_000_000);
		} finally {
			authStorage.close();
			rmSync(tmpModelCacheDir, { recursive: true, force: true });
		}
	});

	it("references CURSOR_API_KEY without embedding its value in provider config", async () => {
		process.env.CURSOR_API_KEY = "do-not-embed-this-key";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();

		await extensionFactory(pi);

		expect(pi._registered[0]?.config.apiKey).toBe("CURSOR_API_KEY");
		expect(JSON.stringify(pi._registered[0]?.config)).not.toContain("do-not-embed-this-key");
	});

	it("registers a lazy Cursor stream wrapper that delegates only when invoked", async () => {
		const mockModels = [makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" })];
		mockedDiscover.mockResolvedValueOnce(mockModels);
		const inner = createAssistantMessageEventStream();
		mockedStreamCursor.mockImplementationOnce(() => inner);
		const pi = createExtensionPi();
		await extensionFactory(pi);

		expect(mockedStreamCursor).not.toHaveBeenCalled();
		const stream = pi._registered[0].config.streamSimple!(makeModel("composer-2"), makeContext(), { apiKey: "test-key" });
		const resultPromise = stream.result();
		await Promise.resolve();
		const message = makeAssistantMessage("done");
		inner.push({ type: "done", reason: "stop", message });

		await expect(resultPromise).resolves.toBe(message);
		expect(mockedStreamCursor).toHaveBeenCalledOnce();
	});

	it("reports and scrubs synchronous Cursor provider runtime failures through the stream", async () => {
		const apiKey = "cursor-dogfood-secret-key";
		mockedStreamCursor.mockImplementationOnce(() => {
			throw new Error(`synchronous provider failure: Bearer ${apiKey}`);
		});
		const stream = streamCursorLazy(makeModel("composer-2"), makeContext(), { apiKey });
		const events: AssistantMessageEvent[] = [];
		const consumeEvents = (async () => {
			for await (const event of stream) events.push(event);
		})();

		const result = await stream.result();
		await consumeEvents;

		expect(events).toHaveLength(1);
		const [errorEvent] = events;
		expect(errorEvent).toMatchObject({ type: "error", reason: "error" });
		if (errorEvent?.type !== "error") throw new Error("Expected a provider error event");
		expect(errorEvent.error).toBe(result);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/^Cursor provider runtime failed: /);
		expect(result.errorMessage).toContain("[redacted]");
		expect(result.errorMessage).not.toContain(apiKey);
	});

	it("keeps only canonical Cursor replay tools active for Cursor models", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		await pi.runTurnStart({ model: makeHarnessModel("openai-codex", "openai-codex-responses", "gpt-5.5") });
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain("grep");
		expect(pi._activeToolNames()).not.toContain("find");
		expect(pi._activeToolNames()).toContain("read");

		await pi.runTurnStart({ model: makeModel("composer-2.5") });
		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
	});

	it("registers and resyncs Cursor-only tools before a turn when session startup did not know the model", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart({ model: undefined });

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME, CURSOR_ACTIVATE_SKILL_TOOL_NAME]);
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain("grep");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		await pi.runBeforeAgentStart({ model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name)).toContain("cursor");
		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(buildCursorPiToolBridgeSnapshot(pi).piToolNameToMcpToolName.get(CURSOR_ASK_QUESTION_TOOL_NAME)).toBe("pi__cursor_ask_question");

		pi.setActiveTools(["read", "bash", "edit", "write"]);
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain("grep");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		await pi.runTurnStart({ model: makeModel("composer-2.5") });

		expect(pi._activeToolNames()).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
	});

	it("does not reactivate Cursor-only tools when pi tools are disabled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionRegistrationPi({ activeTools: [] });
		await extensionFactory(pi);

		await pi.runSessionStart({ model: makeModel("composer-2.5") });
		await pi.runBeforeAgentStart({ model: makeModel("composer-2.5") });
		await pi.runTurnStart({ model: makeModel("composer-2.5") });

		expect(pi._activeToolNames()).toEqual([]);
		expect(buildCursorPiToolBridgeSnapshot(pi).tools).toEqual([]);
	});

	it.each(["json", "rpc"] as const)("registers native replay tools in %s mode for structured host-tool events", async (mode) => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);

		await pi.runSessionStart({ mode, hasUI: false });
		await pi.runBeforeAgentStart({ mode, hasUI: false, model: makeModel("composer-2.5") });
		await pi.runTurnStart({ mode, hasUI: false, model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name)).toContain("cursor");
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).toContain("cursor");
	});

	it("keeps print mode native replay registration off by default", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);

		await pi.runSessionStart({ mode: "print", hasUI: false });
		await pi.runBeforeAgentStart({ mode: "print", hasUI: false, model: makeModel("composer-2.5") });
		await pi.runTurnStart({ mode: "print", hasUI: false, model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name)).toEqual([CURSOR_ASK_QUESTION_TOOL_NAME, CURSOR_ACTIVATE_SKILL_TOOL_NAME]);
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain("cursor");
		expect(pi._activeToolNames()).not.toContain("grep");
	});

	it("deactivates the native replay tool when a later turn switches to print mode", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);

		await pi.runSessionStart({ mode: "json", hasUI: false });
		await pi.runTurnStart({ mode: "json", hasUI: false, model: makeModel("composer-2.5") });

		expect(pi._activeToolNames()).toContain("cursor");

		await pi.runTurnStart({ mode: "print", hasUI: false, model: makeModel("composer-2.5") });

		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain("cursor");

		await pi.runTurnStart({ mode: "json", hasUI: false, model: makeModel("composer-2.5") });

		expect(pi._activeToolNames()).toContain("cursor");
	});

	it("asks Cursor questions through OMP UI selection", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		const select = vi.fn().mockResolvedValue("Web app");
		const input = vi.fn();
		const tool = pi._tools.find((candidate) => candidate.name === CURSOR_ASK_QUESTION_TOOL_NAME);
		const result = await tool!.execute(
			"question-1",
			{
				question: "What kind of calculator should Cursor plan?",
				options: [
					{ label: "Web app", value: "web" },
					{ label: "CLI", value: "cli" },
				],
				allowCustom: false,
			},
			undefined,
			undefined,
			createExtensionTestContext({ ui: { notify: vi.fn(), setStatus: vi.fn(), select, input } }),
		);

		expect(select).toHaveBeenCalledWith("What kind of calculator should Cursor plan?", ["Web app", "CLI"]);
		expect(input).not.toHaveBeenCalled();
		expect(result.content).toEqual([{ type: "text", text: "User answered: Web app" }]);
		expect(result.details).toMatchObject({
			uiAvailable: true,
			cancelled: false,
			answers: [{ id: "question_1", answer: "Web app", value: "web", cancelled: false }],
		});
		expect(pi._eventsEmitted.filter((entry) => entry.channel === CURSOR_ASK_QUESTION_BLOCKED_EVENT)).toEqual([
			{ channel: CURSOR_ASK_QUESTION_BLOCKED_EVENT, data: { active: true } },
			{ channel: CURSOR_ASK_QUESTION_BLOCKED_EVENT, data: { active: false } },
		]);
		expect(Object.hasOwn(tool!, "executionMode")).toBe(false);
		const listenerPayloads: unknown[] = [];
		const unsubscribe = pi.events.on(CURSOR_ASK_QUESTION_BLOCKED_EVENT, (payload) => {
			listenerPayloads.push(payload);
		});
		// Re-run once more to prove createEventBus delivery
		const selectAgain = vi.fn().mockResolvedValue("Yes");
		const deliveryResult = await tool!.execute(
			"question-2",
			{ question: "Again?", options: ["Yes"], allowCustom: false },
			undefined,
			undefined,
			createExtensionTestContext({ ui: { notify: vi.fn(), setStatus: vi.fn(), select: selectAgain, input: vi.fn() } }),
		);
		unsubscribe();
		expect(listenerPayloads).toEqual([{ active: true }, { active: false }]);
		expect(selectAgain).toHaveBeenCalledWith("Again?", ["Yes"]);
		expect(deliveryResult.content).toEqual([{ type: "text", text: "User answered: Yes" }]);
		expect(deliveryResult.details).toMatchObject({
			uiAvailable: true,
			cancelled: false,
			answers: [{ id: "question_1", answer: "Yes", value: "Yes", cancelled: false }],
		});
	});

	it("clears pi-cursor-sdk:ask-question:blocked when the Cursor question UI is cancelled", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		const select = vi.fn().mockResolvedValue(undefined);
		const tool = pi._tools.find((candidate) => candidate.name === CURSOR_ASK_QUESTION_TOOL_NAME);
		const result = await tool!.execute(
			"question-cancel",
			{
				question: "Proceed?",
				options: ["Yes", "No"],
				allowCustom: false,
			},
			undefined,
			undefined,
			createExtensionTestContext({ ui: { notify: vi.fn(), setStatus: vi.fn(), select, input: vi.fn() } }),
		);

		expect(result.details).toMatchObject({ cancelled: true });
		expect(pi._eventsEmitted.filter((entry) => entry.channel === CURSOR_ASK_QUESTION_BLOCKED_EVENT)).toEqual([
			{ channel: CURSOR_ASK_QUESTION_BLOCKED_EVENT, data: { active: true } },
			{ channel: CURSOR_ASK_QUESTION_BLOCKED_EVENT, data: { active: false } },
		]);
	});

	it("clears pi-cursor-sdk:ask-question:blocked when the Cursor question UI rejects", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart();

		const select = vi.fn().mockRejectedValue(new Error("UI failed"));
		const tool = pi._tools.find((candidate) => candidate.name === CURSOR_ASK_QUESTION_TOOL_NAME);
		await expect(
			tool!.execute(
				"question-reject",
				{
					question: "Proceed?",
					options: ["Yes", "No"],
					allowCustom: false,
				},
				undefined,
				undefined,
				createExtensionTestContext({ ui: { notify: vi.fn(), setStatus: vi.fn(), select, input: vi.fn() } }),
			),
		).rejects.toThrow("UI failed");

		expect(pi._eventsEmitted.filter((entry) => entry.channel === CURSOR_ASK_QUESTION_BLOCKED_EVENT)).toEqual([
			{ channel: CURSOR_ASK_QUESTION_BLOCKED_EVENT, data: { active: true } },
			{ channel: CURSOR_ASK_QUESTION_BLOCKED_EVENT, data: { active: false } },
		]);
	});

	it("registers Cursor OMP tool bridge state and activates the Cursor question tool", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();

		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()?.isEnabled()).toBe(true);
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		expect(pi._activeToolNames()).toContain(CURSOR_ASK_QUESTION_TOOL_NAME);

		const snapshot = buildCursorPiToolBridgeSnapshot(pi);
		expect(snapshot.piToolNameToMcpToolName.get(CURSOR_ASK_QUESTION_TOOL_NAME)).toBe("pi__cursor_ask_question");
		expect(snapshot.tools.find((tool) => tool.piToolName === CURSOR_ASK_QUESTION_TOOL_NAME)?.description).toContain("Ask the user");
	});

	it("disables only the Cursor question tool with PI_CURSOR_ASK_QUESTION=0", async () => {
		expect(resolveCursorAskQuestionEnabled({})).toBe(true);
		for (const value of ["0", "false", "off", "none", "no", "disabled"]) {
			expect(resolveCursorAskQuestionEnabled({ PI_CURSOR_ASK_QUESTION: value })).toBe(false);
		}

		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		process.env.PI_CURSOR_ASK_QUESTION = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const bridgeToolName = "sem_reindex";
		const pi = createExtensionRegistrationPi({
			initialTools: [createTestToolInfo(bridgeToolName)],
			activeTools: [bridgeToolName],
		});

		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()?.isEnabled()).toBe(true);
		expect(pi._tools.map((tool) => tool.name)).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		expect(pi._activeToolNames()).not.toContain(CURSOR_ASK_QUESTION_TOOL_NAME);
		const snapshot = buildCursorPiToolBridgeSnapshot(pi);
		expect(snapshot.piToolNameToMcpToolName.has(CURSOR_ASK_QUESTION_TOOL_NAME)).toBe(false);
		expect(snapshot.piToolNameToMcpToolName.get(bridgeToolName)).toBe(`pi__${bridgeToolName}`);
	});

	it("honors PI_CURSOR_PI_TOOL_BRIDGE=0 at the extension registration path", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();

		await extensionFactory(pi);
		await pi.runSessionStart();

		expect(cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()?.isEnabled()).toBe(false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("registers fallback models through authoritative discovery", async () => {
		const fallbackModels = [
			makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" }),
			makeProviderModelConfig("gpt-5.5", {
				name: "GPT-5.5",
				reasoning: true,
				contextWindow: 1_000_000,
			}),
		];
		mockedDiscover.mockResolvedValueOnce(fallbackModels);
		mockedFetchDynamic.mockResolvedValueOnce([]);

		const pi = createExtensionPi();
		await extensionFactory(pi);

		expect(pi.registerProvider).toHaveBeenCalledOnce();
		const [call] = pi._registered;
		expect(call.config.models).toBeUndefined();
		await expect(call.config.fetchDynamicModels?.(undefined)).resolves.toBe(fallbackModels);
	});

	it("refreshes Cursor SDK models through OMP without re-registering the provider", async () => {
		const startupModels = [makeProviderModelConfig("composer-2", { name: "Cursor Composer 2" })];
		mockedDiscover.mockResolvedValueOnce(startupModels);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();
		const getApiKeyForProvider = vi.fn().mockResolvedValue(" registry-key ");
		const refreshProvider = vi.fn().mockResolvedValue(undefined);

		await pi.runCommand(
			"cursor-refresh-models",
			"",
			createExtensionCommandContext({
				hasUI: true,
				model: undefined,
				modelRegistry: { getApiKeyForProvider, refreshProvider } as never,
				ui: { notify },
			}),
		);

		expect(getApiKeyForProvider).toHaveBeenCalledWith(CURSOR_SDK_PROVIDER_ID);
		expect(refreshProvider).toHaveBeenCalledWith(CURSOR_SDK_PROVIDER_ID, "online");
		expect(mockedDiscover).toHaveBeenCalledOnce();
		expect(pi.registerProvider).toHaveBeenCalledOnce();
		expect(pi._registered[0].config.models).toBeUndefined();
		expect(notify).toHaveBeenCalledWith("Cursor SDK model catalog refreshed.", "info");
	});

	it("refreshes the current Cursor SDK agent config through a command", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		await pi.runSessionStart({ sessionManager: { getSessionFile: vi.fn(() => "/tmp/sessions/refresh-config.jsonl") } });
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/refresh-config.jsonl");
		const reload = vi.fn().mockResolvedValue(undefined);
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent: vi.fn().mockResolvedValue({
				agentId: "agent-refresh-config",
				reload,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			}),
		});
		const notify = vi.fn();

		await pi.runCommand("cursor-refresh-config", "", createExtensionCommandContext({ model: makeModel("composer-2.5"), ui: { notify } }));

		expect(reload).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("Cursor SDK agent config refreshed.", "info");
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
	});

	it("handles cursor-refresh-config before an agent exists", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();

		await pi.runCommand("cursor-refresh-config", "", createExtensionCommandContext({ model: makeModel("composer-2.5"), ui: { notify } }));

		expect(notify).toHaveBeenCalledWith("No Cursor SDK agent exists yet; config will load on the next Cursor run.", "warning");
	});

	it("handles cursor-refresh-config on non-Cursor models", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();

		await pi.runCommand(
			"cursor-refresh-config",
			"",
			createExtensionCommandContext({ model: makeHarnessModel("openai", "openai-chat", "gpt-test"), ui: { notify } }),
		);

		expect(notify).toHaveBeenCalledWith("Cursor config refresh is available only for Cursor models.", "info");
	});

	it("rejects model refresh without Cursor SDK credentials", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();
		const refreshProvider = vi.fn();

		await pi.runCommand(
			"cursor-refresh-models",
			"",
			createExtensionCommandContext({
				modelRegistry: {
					getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
					refreshProvider,
				} as never,
				ui: { notify },
			}),
		);

		expect(refreshProvider).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Cursor SDK model refresh requires a Cursor SDK API key; run /login cursor-sdk or set CURSOR_API_KEY.",
			"error",
		);
	});

	it("reports OMP provider refresh failures without replacing the catalog", async () => {
		mockedDiscover.mockResolvedValueOnce([]);
		const pi = createExtensionPi();
		await extensionFactory(pi);
		const notify = vi.fn();

		await pi.runCommand(
			"cursor-refresh-models",
			"",
			createExtensionCommandContext({
				modelRegistry: {
					getApiKeyForProvider: vi.fn().mockResolvedValue("registry-key"),
					refreshProvider: vi.fn().mockRejectedValue(new Error("Cursor SDK model discovery failed for registry-key: unavailable")),
				} as never,
				ui: { notify },
			}),
		);

		expect(pi.registerProvider).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith("Cursor SDK model discovery failed for [redacted]: unavailable", "error");
	});
});

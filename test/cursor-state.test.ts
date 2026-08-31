import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	registerCursorRuntimeControls,
	getEffectiveFastForModelId,
	getCursorProviderAgentModeOrThrow,
	getStoredCursorAgentMode,
	resolveCursorAgentMode,
	formatCursorToolsDebugReport,
	getCursorCliConfig,
	__testUtils,
} from "../src/cursor-state.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_HTTP1_ENV } from "../src/cursor-config.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeHarnessModel,
	makeModel,
} from "./helpers/pi-harness.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";

const modelItems: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Cursor Composer 2",
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [
			{
				params: [{ id: "fast", value: "true" }],
				displayName: "Cursor Composer 2",
				isDefault: true,
			},
		],
	},
	{
		id: "composer-2.5",
		displayName: "Cursor Composer 2.5",
		aliases: ["composer-2-5"],
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [
			{
				params: [{ id: "fast", value: "true" }],
				displayName: "Cursor Composer 2.5",
				isDefault: true,
			},
		],
	},
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
			{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "reasoning", value: "medium" },
					{ id: "fast", value: "false" },
				],
				displayName: "GPT-5.5",
				isDefault: true,
			},
		],
	},
	{
		id: "future-three-tier",
		displayName: "Future Three Tier",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "128k" }, { value: "256k" }, { value: "1m" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "fast", value: "false" },
				],
				displayName: "Future Three Tier",
				isDefault: true,
			},
		],
	},
	{
		id: "gemini-3.1-pro",
		displayName: "Gemini 3.1 Pro",
		variants: [{ params: [], displayName: "Gemini 3.1 Pro", isDefault: true }],
	},
];

function createCursorRuntimeHarness(options: {
	modelId?: string;
	provider?: string;
	api?: string;
	branch?: SessionEntry[];
	cursorFastFlag?: boolean;
	cursorNoFastFlag?: boolean;
	cursorModeFlag?: boolean | string;
	cursorLocalResumeFlag?: boolean;
	cursorNoLocalResumeFlag?: boolean;
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	cwd?: string;
} = {}) {
	const pi = createPiHarness({
		flagValues: {
			"cursor-fast": options.cursorFastFlag ?? false,
			"cursor-no-fast": options.cursorNoFastFlag ?? false,
			"cursor-mode": options.cursorModeFlag ?? "",
			"cursor-local-resume": options.cursorLocalResumeFlag ?? false,
			"cursor-no-local-resume": options.cursorNoLocalResumeFlag ?? false,
		},
	});
	const ctx = createExtensionTestContext({
		cwd: options.cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		model: options.modelId
			? {
					...makeModel(options.modelId),
					provider: options.provider ?? "cursor-sdk",
					api: (options.api ?? "cursor-sdk") as "cursor-sdk",
				}
			: undefined,
		sessionManager: {
			getBranch: vi.fn<ExtensionContext["sessionManager"]["getBranch"]>(() => options.branch ?? []),
		},
	});
	registerCursorRuntimeControls(pi);
	const commandCtx = createExtensionCommandContext({
		cwd: ctx.cwd,
		model: ctx.model,
		ui: ctx.ui,
		sessionManager: ctx.sessionManager,
	});
	return { pi, ctx, commandCtx, commands: pi._commands };
}

describe("Cursor runtime state", () => {
	let tmpAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalHttp1Env = process.env[CURSOR_HTTP1_ENV];
	const originalResolvedAgentDir = getAgentDir();

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "omp-cursor-state-"));
		setAgentDir(tmpAgentDir);
		delete process.env[CURSOR_HTTP1_ENV];
		__testUtils.sessionFastPreferences.clear();
		__testUtils.resetCursorModeStateForTests();
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	afterEach(() => {
		setAgentDir(originalResolvedAgentDir);
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		if (originalHttp1Env === undefined) delete process.env[CURSOR_HTTP1_ENV];
		else process.env[CURSOR_HTTP1_ENV] = originalHttp1Env;
		rmSync(tmpAgentDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("defaults Cursor SDK mode to agent", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("defaults fresh fast-capable Composer sessions to fast off despite SDK catalog default=true", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
	});

	it("forces Cursor SDK plan mode with --cursor-mode without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5", cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces Cursor SDK agent mode with --cursor-mode over a persisted plan preference", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "gpt-5.5",
			cursorModeFlag: "agent",
			branch: [
				{
					type: "custom",
					id: "mode-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.MODE_ENTRY_TYPE,
					data: { mode: "plan" },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("reports invalid --cursor-mode values in UI sessions and rejects provider mode reads", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5", cursorModeFlag: "review" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith('Invalid --cursor-mode "review". Use "agent" or "plan".', "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · mode invalid");
		expect(resolveCursorAgentMode()).toEqual({
			kind: "invalid",
			raw: "review",
			message: 'Invalid --cursor-mode "review". Use "agent" or "plan".',
		});
		expect(getStoredCursorAgentMode()).toBe("agent");
		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');
	});

	it("reports invalid --cursor-mode from /cursor-mode status instead of soft defaulting", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({
			modelId: "gpt-5.5",
			cursorModeFlag: "review",
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		vi.mocked(ctx.ui.notify).mockClear();

		await commands.get("cursor-mode")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Invalid --cursor-mode "review". Use "agent" or "plan". Usage: /cursor-mode agent|plan',
			"error",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith("Cursor mode is agent. Usage: /cursor-mode agent|plan", "info");
	});

	it("allows /cursor-mode to recover an interactive session from invalid --cursor-mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({
			modelId: "gpt-5.5",
			cursorModeFlag: "review",
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');

		await commands.get("cursor-mode")!.handler("plan", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MODE_ENTRY_TYPE, { mode: "plan" });
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cursor mode set to plan; cleared invalid --cursor-mode override",
			"info",
		);
	});

	it("does not abort non-Cursor RPC sessions for invalid --cursor-mode", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
			mode: "rpc",
			hasUI: true,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(resolveCursorAgentMode()).toEqual({
			kind: "invalid",
			raw: "review",
			message: 'Invalid --cursor-mode "review". Use "agent" or "plan".',
		});
		expect(getStoredCursorAgentMode()).toBe("agent");
	});

	it("does not abort non-Cursor JSON sessions for invalid --cursor-mode", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
			mode: "json",
			hasUI: false,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(resolveCursorAgentMode()).toEqual({
			kind: "invalid",
			raw: "review",
			message: 'Invalid --cursor-mode "review". Use "agent" or "plan".',
		});
		expect(getStoredCursorAgentMode()).toBe("agent");
	});

	it("reports invalid --cursor-mode when a non-Cursor session later selects a Cursor model", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
			cursorModeFlag: "review",
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		const selectedModel = { ...makeModel("composer-2"), provider: "cursor-sdk", api: "cursor-sdk" as const };
		await pi.invokeEventWithContext(
			"turn_start",
			{ type: "turn_start", turnIndex: 1, timestamp: Date.now() },
			{ ...ctx, model: selectedModel },
		);

		expect(ctx.ui.notify).toHaveBeenCalledWith('Invalid --cursor-mode "review". Use "agent" or "plan".', "error");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · mode invalid");
	});

	it("rejects invalid --cursor-mode for Cursor provider runs", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			cursorModeFlag: "review",
			mode: "rpc",
			hasUI: true,
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(() => getCursorProviderAgentModeOrThrow()).toThrow('Invalid --cursor-mode "review"');
	});

	it("persists /cursor-mode plan as session mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5" });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-mode")!.handler("plan", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MODE_ENTRY_TYPE, { mode: "plan" });
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode set to plan", "info");
	});

	it("persists /cursor-mode agent as session mode", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({
			modelId: "gpt-5.5",
			branch: [
				{
					type: "custom",
					id: "mode-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.MODE_ENTRY_TYPE,
					data: { mode: "plan" },
				},
			],
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });

		await commands.get("cursor-mode")!.handler("agent", commandCtx);

		expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MODE_ENTRY_TYPE, { mode: "agent" });
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode set to agent", "info");
	});

	it("reports current mode and usage for /cursor-mode with no args", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5", cursorModeFlag: "plan" });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-mode")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor mode is plan. Usage: /cursor-mode agent|plan", "info");
	});

	it("combines explicit Cursor fast and plan mode in one status value", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorFastFlag: true, cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on · plan");
	});

	it("updates Cursor mode status when switching between Cursor models", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "composer-2": true } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorModeFlag: "plan" });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on · plan");

		const selectedModel = { ...makeModel("gpt-5.5"), provider: "cursor-sdk", api: "cursor-sdk" as const };
		await pi.invokeEventWithContext(
			"turn_start",
			{ type: "turn_start", turnIndex: 1, timestamp: Date.now() },
			{ ...ctx, model: selectedModel },
		);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");
	});

	it("restores fast state from the active session branch", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			branch: [
				{
					type: "custom",
					id: "fast-entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: __testUtils.FAST_ENTRY_TYPE,
					data: { baseModelId: "composer-2", fast: false },
				},
			],
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
	});

	it("restores fast and mode together when session tree navigation changes branches", async () => {
		const entry = (id: string, customType: string, data: Record<string, unknown>): SessionEntry => ({
			type: "custom",
			id,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType,
			data,
		});
		const planBranch = [
			entry("fast-off", __testUtils.FAST_ENTRY_TYPE, { baseModelId: "composer-2", fast: false }),
			entry("mode-plan", __testUtils.MODE_ENTRY_TYPE, { mode: "plan" }),
		];
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			branch: planBranch,
		});
		const getBranch = vi.mocked(ctx.sessionManager.getBranch);
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });

		getBranch.mockReturnValue([
			entry("fast-on", __testUtils.FAST_ENTRY_TYPE, { baseModelId: "composer-2", fast: true }),
			entry("mode-agent", __testUtils.MODE_ENTRY_TYPE, { mode: "agent" }),
		]);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(true);
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");

		getBranch.mockReturnValue(planBranch);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "plan" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off · plan");

		getBranch.mockReturnValue([]);
		await pi.invokeEventWithContext("session_tree", { type: "session_tree", oldLeafId: null, newLeafId: null }, ctx);
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(resolveCursorAgentMode()).toEqual({ kind: "valid", mode: "agent" });
	});

	it("uses global fast defaults for new sessions", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true } }));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5")).toBe(true);
	});

	it("forces fast with the CLI flag without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5", cursorFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces fast off with --cursor-no-fast without writing session state", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("maps local resume CLI flags and lets --cursor-no-local-resume win", async () => {
		let harness = createCursorRuntimeHarness({ cursorLocalResumeFlag: true });
		await harness.pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(getCursorCliConfig().local?.resume).toBe(true);

		harness = createCursorRuntimeHarness({ cursorLocalResumeFlag: true, cursorNoLocalResumeFlag: true });
		await harness.pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(getCursorCliConfig().local?.resume).toBe(false);
	});

	it("lets --cursor-no-fast win when both one-run force flags are set", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not apply --cursor-no-fast to unsupported Cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", cursorNoFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:n/a");
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("keeps not-applicable fast status when unsupported Cursor models run in plan mode", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", cursorModeFlag: "plan" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:n/a · plan");
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not let /cursor-fast persist while --cursor-no-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "composer-2", cursorNoFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
		expect(getEffectiveFastForModelId("composer-2")).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("mentions --cursor-no-fast when both force flags block /cursor-fast", async () => {
		const { ctx, commandCtx, commands, pi } = createCursorRuntimeHarness({ modelId: "composer-2", cursorFastFlag: true, cursorNoFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced off by --cursor-no-fast", "info");
	});

	it("does not let /cursor-fast persist an opposite value when --cursor-fast is active", async () => {
		const { pi, ctx, commandCtx, commands } = createCursorRuntimeHarness({ modelId: "gpt-5.5", cursorFastFlag: true });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor fast is forced by --cursor-fast", "info");
		expect(getEffectiveFastForModelId("gpt-5.5")).toBe(true);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies and no-ops when the selected model does not support fast", async () => {
		const { ctx, commandCtx, commands, pi } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro" });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Fast mode not supported by gemini-3.1-pro", "info");
	});

	it("shares fast preference across explicit variants of non-converged models", async () => {
		const { ctx, commandCtx, commands, pi } = createCursorRuntimeHarness({
			modelId: "future-three-tier@128k",
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		await commands.get("cursor-fast")!.handler("", commandCtx);

		expect(getEffectiveFastForModelId("future-three-tier")).toBe(true);
		expect(getEffectiveFastForModelId("future-three-tier@256k")).toBe(true);
		expect(JSON.parse(readFileSync(__testUtils.getConfigPath(), "utf-8"))).toEqual({
			fastDefaults: { "future-three-tier": true },
		});
	});

	it("clears Cursor status when model_select moves from Cursor fast model to non-cursor model", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "composer-2" });
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");

		const selectedModel = makeHarnessModel("anthropic", "anthropic-messages", "claude-sonnet-4-5");
		await pi.invokeEventWithContext(
			"turn_start",
			{ type: "turn_start", turnIndex: 1, timestamp: Date.now() },
			{ ...ctx, model: selectedModel },
		);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("ignores malformed global config without throwing", async () => {
		writeFileSync(__testUtils.getConfigPath(), "{not json");
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5" });

		await expect(
			pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx),
		).resolves.toBeUndefined();

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
		expect(getEffectiveFastForModelId("gpt-5.5")).toBe(false);
	});

	it("filters global config entries with invalid fast default values", async () => {
		writeFileSync(__testUtils.getConfigPath(), JSON.stringify({ fastDefaults: { "gpt-5.5": true, "composer-2": "true" } }));
		expect(__testUtils.loadGlobalFastPreferences()).toEqual(new Map([["gpt-5.5", true]]));
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gpt-5.5" });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:on");
		expect(getEffectiveFastForModelId("gpt-5.5")).toBe(true);
	});

	it("does not apply or persist --cursor-fast for unsupported Cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({ modelId: "gemini-3.1-pro", cursorFastFlag: true });

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:n/a");
		expect(getEffectiveFastForModelId("gemini-3.1-pro")).toBeUndefined();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("clears Cursor status for non-cursor models", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			provider: "anthropic",
			api: "anthropic-messages",
			modelId: "claude-sonnet-4-5",
		});

		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("refreshes Cursor fast status on turn_start after session_start without a model", async () => {
		const { pi, ctx } = createCursorRuntimeHarness();
		await pi.invokeEventWithContext("session_start", { type: "session_start"}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);

		ctx.model = makeModel("composer-2");
		await pi.invokeEventWithContext("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", "cursor:local · fast:off");
	});

	it("ignores cursor-sdk API models outside the independent provider", async () => {
		const { pi, ctx } = createCursorRuntimeHarness({
			modelId: "composer-2",
			provider: "other-provider",
		});
		ctx.model = { ...makeModel("composer-2"), provider: "other-provider", api: "cursor-sdk" };

		await pi.invokeEventWithContext("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", undefined);
	});

	it("registers /cursor-tools and reports bridge and setting sources", async () => {
		const originalBridgeEnv = process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		const originalSettingSourcesEnv = process.env.PI_CURSOR_SETTING_SOURCES;
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "1";
		process.env.PI_CURSOR_SETTING_SOURCES = "none";
		try {
			const pi = createPiHarness({
				activeTools: ["custom_bridge_tool"],
				initialTools: [createTestToolInfo("custom_bridge_tool", undefined, "Custom bridge tool")],
			});
			registerCursorRuntimeControls(pi);
			const ctx = createExtensionTestContext();
			await pi.runCommand("cursor-tools", "", { ui: ctx.ui, hasUI: true });

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_CURSOR_PI_TOOL_BRIDGE: enabled"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_CURSOR_SETTING_SOURCES: none (effective: none)"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Callable tool surfaces this run:"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi__custom_bridge_tool"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cursor host/MCP"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("OMP tool toggles affect OMP tools/bridge exposure only"), "info");
		} finally {
			if (originalBridgeEnv === undefined) delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
			else process.env.PI_CURSOR_PI_TOOL_BRIDGE = originalBridgeEnv;
			if (originalSettingSourcesEnv === undefined) delete process.env.PI_CURSOR_SETTING_SOURCES;
			else process.env.PI_CURSOR_SETTING_SOURCES = originalSettingSourcesEnv;
		}
	});

	it("formatCursorToolsDebugReport notes disabled bridge", () => {
		const pi = createPiHarness();
		const report = formatCursorToolsDebugReport(pi, {
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_SETTING_SOURCES: "project",
		});
		expect(report).toContain("PI_CURSOR_PI_TOOL_BRIDGE: disabled");
		expect(report).toContain("OMP bridge: disabled (PI_CURSOR_PI_TOOL_BRIDGE=0).");
		expect(report).toContain("PI_CURSOR_SETTING_SOURCES: project (effective: project)");
		expect(report).toContain("Callable tool surfaces this run:");
	});

	it("formatCursorToolsDebugReport notes disabled manifest", () => {
		const pi = createPiHarness();
		const report = formatCursorToolsDebugReport(pi, {
			PI_CURSOR_TOOL_MANIFEST: "0",
		});
		expect(report).toContain("PI_CURSOR_TOOL_MANIFEST: disabled");
	});

	it("logs /cursor-tools to stdout when UI is unavailable", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const pi = createPiHarness();
			registerCursorRuntimeControls(pi);
			await pi.runCommand("cursor-tools", "", { hasUI: false });

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Cursor tool surfaces (current session):"));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Callable tool surfaces this run:"));
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

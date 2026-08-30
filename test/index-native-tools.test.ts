import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionTestContext, createTestToolInfo, getHarnessRegisteredTool, makeHarnessModel, makeModel } from "./helpers/pi-harness.js";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { createRenderOptions, createRenderTheme } from "./helpers/render-fixtures.js";

vi.mock("../src/model-discovery.js", () => ({
	fetchCursorDynamicModels: vi.fn(),
	getCursorFallbackModels: vi.fn(),
	getCursorModelMetadata: vi.fn(),
}));

vi.mock("../src/cursor-provider.js", () => ({
	streamCursor: vi.fn(),
}));

import extensionFactory from "../src/index.js";
import { getCursorFallbackModels } from "../src/model-discovery.js";
import {
	canRenderCursorToolNatively,
	isRegisteredCursorNativeToolName,
	recordCursorNativeToolDisplay,
} from "../src/cursor-native-tool-display-state.js";
import { CURSOR_ASK_QUESTION_TOOL_NAME } from "../src/cursor-question-tool.js";
import { CURSOR_ACTIVATE_SKILL_TOOL_NAME } from "../src/cursor-skill-tool.js";

const mockedFallbackModels = getCursorFallbackModels as Mock<typeof getCursorFallbackModels>;

async function loadExtension() {
	mockedFallbackModels.mockResolvedValueOnce([]);
	const pi = createExtensionPi();
	await extensionFactory(pi);
	return pi;
}

describe("extension native Cursor tool replay", () => {
	beforeEach(resetIndexExtensionTestState);

	it("defers replay-tool registration until a cursor-sdk session starts", async () => {
		const pi = await loadExtension();

		expect(pi._tools.map((tool) => tool.name)).toEqual([
			CURSOR_ASK_QUESTION_TOOL_NAME,
			CURSOR_ACTIVATE_SKILL_TOOL_NAME,
		]);
		expect(canRenderCursorToolNatively("cursor")).toBe(false);

		await pi.runSessionStart({ model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name)).toContain("cursor");
		expect(canRenderCursorToolNatively("cursor")).toBe(true);
	});

	it("does not activate replay tools for OMP's builtin cursor provider", async () => {
		const pi = await loadExtension();
		const builtinCursorModel = makeHarnessModel("cursor", "openai-completions", "gpt-5.6");

		await pi.runSessionStart({ model: builtinCursorModel });

		expect(pi._tools.map((tool) => tool.name)).not.toContain("cursor");
		expect(canRenderCursorToolNatively("cursor")).toBe(false);
	});

	it("registers only the neutral replay tool and never shadows OMP builtins", async () => {
		const pi = await loadExtension();
		await pi.runSessionStart({ model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name).sort()).toEqual([
			CURSOR_ACTIVATE_SKILL_TOOL_NAME,
			CURSOR_ASK_QUESTION_TOOL_NAME,
			"cursor",
		].sort());
		for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(isRegisteredCursorNativeToolName(builtin)).toBe(false);
			expect(canRenderCursorToolNatively(builtin)).toBe(true);
		}
	});

	it("returns a recorded neutral replay result without executing real work", async () => {
		const pi = await loadExtension();
		await pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(recordCursorNativeToolDisplay({
			id: "cursor-replay-1",
			toolName: "cursor",
			args: { activityTitle: "Cursor web search" },
			result: {
				content: [{ type: "text", text: "web search TypeScript 5.9" }],
				details: { variant: "activity", sourceToolName: "webSearch", title: "Cursor web search", summary: "TypeScript 5.9" },
			},
			isError: false,
		})).toBe(true);

		const cursorTool = getHarnessRegisteredTool(pi._tools, "cursor");
		const result = await cursorTool.execute(
			"cursor-replay-1",
			{ activityTitle: "Cursor web search" },
			undefined,
			undefined,
			createExtensionTestContext(),
		);

		expect(result).toEqual({
			content: [{ type: "text", text: "web search TypeScript 5.9" }],
			details: { variant: "activity", sourceToolName: "webSearch", title: "Cursor web search", summary: "TypeScript 5.9" },
			terminate: true,
		});
	});

	it("renders neutral replay calls and collapsed or expanded results through OMP 18's render contract", async () => {
		const pi = await loadExtension();
		await pi.runSessionStart({ model: makeModel("composer-2.5") });
		const cursorTool = getHarnessRegisteredTool(pi._tools, "cursor");
		const theme = createRenderTheme();
		const args = { activityTitle: "Cursor web search", activitySummary: "TypeScript 5.9" };
		const result = {
			content: [{ type: "text" as const, text: "web search TypeScript 5.9\n\nLinks:\n1. https://example.com" }],
			details: {
				variant: "activity",
				sourceToolName: "webSearch",
				title: "Cursor web search",
				summary: "TypeScript 5.9",
				expandedText: "Links:\n1. https://example.com",
				collapseDetailsByDefault: true,
			},
		};

		const call = cursorTool.renderCall?.(args, createRenderOptions({ isPartial: true }), theme).render(120).join("\n") ?? "";
		const collapsed = cursorTool.renderResult?.(result, createRenderOptions(), theme, args).render(120).join("\n") ?? "";
		const expanded = cursorTool.renderResult?.(result, createRenderOptions({ expanded: true }), theme, args).render(120).join("\n") ?? "";

		expect(call).toContain("Cursor web search TypeScript 5.9");
		expect(collapsed).toContain("Cursor web search TypeScript 5.9");
		expect(collapsed).not.toContain("https://example.com");
		expect(expanded).toContain("https://example.com");
	});

	it("does not replace another extension's cursor tool", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		mockedFallbackModels.mockResolvedValueOnce([]);
		const pi = createExtensionPi([createTestToolInfo("cursor")]);
		await extensionFactory(pi);

		const notify = vi.fn();
		await pi.runSessionStart({ model: makeModel("composer-2.5"), ui: { notify } });
		expect(pi._tools.map((tool) => tool.name)).not.toContain("cursor");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain("skipped for cursor because another extension already provides that tool");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
	});

	it("does not register replay tools in print mode", async () => {
		const pi = await loadExtension();

		await pi.runSessionStart({ mode: "print", model: makeModel("composer-2.5") });

		expect(pi._tools.map((tool) => tool.name)).not.toContain("cursor");
		expect(canRenderCursorToolNatively("cursor")).toBe(false);
	});

	it("removes the neutral replay tool from the active set after switching away from cursor-sdk", async () => {
		const pi = await loadExtension();
		await pi.runSessionStart({ model: makeModel("composer-2.5") });
		expect(pi.getActiveTools()).toContain("cursor");

		await pi.runSessionStart({ model: makeHarnessModel("openai", "openai-completions", "gpt-5.6") });

		expect(pi.getActiveTools()).not.toContain("cursor");
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "../src/cursor-model.js";
import { scheduleCursorSdkRuntimePrewarm } from "../src/cursor-sdk-runtime-prewarm.js";
import { prewarmCursorSdkRuntime } from "../src/cursor-sdk-runtime.js";
import { resolveEffectiveCursorConfigForContext } from "../src/cursor-runtime-state.js";

vi.mock("../src/cursor-sdk-runtime.js", () => ({
	prewarmCursorSdkRuntime: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/cursor-runtime-state.js", () => ({
	resolveEffectiveCursorConfigForContext: vi.fn(),
}));

function cursorCtx(): ExtensionContext {
	return { model: { provider: CURSOR_SDK_PROVIDER_ID }, cwd: "/tmp/project" } as ExtensionContext;
}

describe("scheduleCursorSdkRuntimePrewarm", () => {
	beforeEach(() => {
		vi.mocked(prewarmCursorSdkRuntime).mockClear();
		vi.mocked(resolveEffectiveCursorConfigForContext).mockReset();
	});

	it("starts local cursor-sdk warmup without returning the import promise", () => {
		vi.mocked(resolveEffectiveCursorConfigForContext).mockReturnValue({
			runtime: { value: "local" },
		} as ReturnType<typeof resolveEffectiveCursorConfigForContext>);
		const result = scheduleCursorSdkRuntimePrewarm(cursorCtx());
		expect(result).toBeUndefined();
		expect(prewarmCursorSdkRuntime).toHaveBeenCalledOnce();
	});

	it("skips non-cursor models and cloud runtime", () => {
		scheduleCursorSdkRuntimePrewarm({ model: { provider: "openai" }, cwd: "/tmp/project" } as ExtensionContext);
		expect(prewarmCursorSdkRuntime).not.toHaveBeenCalled();

		vi.mocked(resolveEffectiveCursorConfigForContext).mockReturnValue({
			runtime: { value: "cloud" },
		} as ReturnType<typeof resolveEffectiveCursorConfigForContext>);
		scheduleCursorSdkRuntimePrewarm(cursorCtx());
		expect(prewarmCursorSdkRuntime).not.toHaveBeenCalled();
	});
});

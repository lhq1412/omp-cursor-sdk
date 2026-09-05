import { afterEach, describe, expect, it, vi } from "vitest";
import { prewarmCursorSdkRuntime, resetCursorSdkRuntimePrewarmForTests } from "../src/cursor-sdk-runtime.js";

describe("prewarmCursorSdkRuntime", () => {
	afterEach(() => {
		resetCursorSdkRuntimePrewarmForTests();
	});

	it("pays the SDK import once and shares the in-flight promise", async () => {
		let resolveLoad: (value: unknown) => void = () => {};
		const loader = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveLoad = resolve;
				}),
		);
		const first = prewarmCursorSdkRuntime(loader);
		const second = prewarmCursorSdkRuntime(loader);
		expect(loader).toHaveBeenCalledOnce();
		expect(first).toBe(second);
		resolveLoad({});
		await first;
		await prewarmCursorSdkRuntime(loader);
		expect(loader).toHaveBeenCalledOnce();
	});

	it("retries after a failed warmup", async () => {
		const loader = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({});
		await expect(prewarmCursorSdkRuntime(loader)).rejects.toThrow("boom");
		await prewarmCursorSdkRuntime(loader);
		expect(loader).toHaveBeenCalledTimes(2);
	});
});

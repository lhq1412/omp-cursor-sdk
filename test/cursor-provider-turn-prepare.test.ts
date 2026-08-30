import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { resolveCursorSdkConfig, type CursorResolvedSdkConfig } from "../src/cursor-config.js";
import { installCursorSdkProcessErrorGuard } from "../src/cursor-sdk-process-error-guard.js";
import { makeAssistantMessage, makeContext, makeModel } from "./helpers/pi-harness.js";

function makeResolvedConfig(runtime: "local" | "cloud"): CursorResolvedSdkConfig {
	return resolveCursorSdkConfig({
		env: {},
		builtIn: { runtime, cloud: { contextHandoff: "bootstrap" } },
	});
}

const { mockResolveCursorProviderTurnConfig, mockPrepareCursorProviderTurn } = vi.hoisted(() => ({
	mockResolveCursorProviderTurnConfig: vi.fn(),
	mockPrepareCursorProviderTurn: vi.fn(),
}));

vi.mock("../src/cursor-provider-turn-prepare.js", () => ({
	resolveCursorProviderTurnConfig: mockResolveCursorProviderTurnConfig,
	prepareCursorProviderTurn: mockPrepareCursorProviderTurn,
	requireCursorApiKey: vi.fn(async () => "test-key"),
}));


describe("CursorProviderTurnRunner config snapshotting (F3)", () => {
	it("resolves the effective config exactly once per turn and threads the same snapshot into prepare, even if config changes during drain", async () => {
		const { CursorProviderTurnRunner } = await import("../src/cursor-provider-turn-runner.js");

		const localSnapshot = makeResolvedConfig("local");
		mockResolveCursorProviderTurnConfig.mockImplementationOnce(() => {
			queueMicrotask(() => mockResolveCursorProviderTurnConfig.mockReturnValue(makeResolvedConfig("cloud")));
			return localSnapshot;
		});
		const prepareMarker = new Error("stop after prepare capture");
		mockPrepareCursorProviderTurn.mockImplementation(async () => {
			throw prepareMarker;
		});

		const runner = new CursorProviderTurnRunner({
			model: makeModel(),
			context: makeContext(),
			stream: createAssistantMessageEventStream(),
			partial: makeAssistantMessage(""),
			options: { apiKey: "test-key" },
			sdkEventDebugRef: {},
		});

		await runner.run(installCursorSdkProcessErrorGuard());

		expect(mockResolveCursorProviderTurnConfig).toHaveBeenCalledTimes(1);
		expect(mockPrepareCursorProviderTurn).toHaveBeenCalledTimes(1);
		const preparedCallArgs = mockPrepareCursorProviderTurn.mock.calls[0]?.[0] as { resolvedConfig: CursorResolvedSdkConfig };
		expect(preparedCallArgs.resolvedConfig).toBe(localSnapshot);
		expect(preparedCallArgs.resolvedConfig.runtime.value).toBe("local");
	});
});

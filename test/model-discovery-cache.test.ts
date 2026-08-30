import type { Mock } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	__testUtils,
	buildCursorModelSelection,
	fetchCursorDynamicModels,
	getCursorFallbackModels,
	getCursorModelMetadata,
} from "../src/model-discovery.js";

vi.mock("@cursor/sdk", () => ({
	Cursor: { models: { list: vi.fn() } },
}));

import { Cursor } from "@cursor/sdk";

const mockedList = Cursor.models.list as Mock<typeof Cursor.models.list>;

const LIVE_ONLY_MODEL: ModelListItem = {
	id: "future-model",
	displayName: "Future Model",
	parameters: [
		{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "high" }] },
		{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
	],
	variants: [
		{
			params: [
				{ id: "effort", value: "high" },
				{ id: "fast", value: "false" },
			],
			displayName: "Future Model",
			isDefault: true,
		},
	],
};

describe("OMP dynamic model cache integration", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		delete process.env.PI_CURSOR_SDK_DISABLE_MODEL_CACHE;
		tmpAgentDir = mkdtempSync(join(tmpdir(), "omp-cursor-dynamic-models-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		mockedList.mockReset();
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	it("preserves variant-only defaults without exposing unknown controls", async () => {
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-opus-4-8",
				displayName: "Opus 4.8",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "high" }] },
				],
				variants: [
					{
						params: [
							{ id: "cyber", value: "false" },
							{ id: "thinking", value: "true" },
							{ id: "effort", value: "high" },
						],
						displayName: "Opus 4.8",
						isDefault: true,
					},
				],
			},
		]);

		await fetchCursorDynamicModels("test-key-123");

		expect(getCursorModelMetadata("claude-opus-4-8")?.parameterIds).toEqual({
			context: false,
			reasoning: false,
			effort: true,
			thinking: true,
			fast: false,
		});
		expect(buildCursorModelSelection("claude-opus-4-8", Effort.Low)).toEqual({
			id: "claude-opus-4-8",
			params: [
				{ id: "cyber", value: "false" },
				{ id: "thinking", value: "true" },
				{ id: "effort", value: "low" },
			],
		});
	});

	it("leaves fetch cadence to OMP instead of serving a second local catalog", async () => {
		mockedList.mockResolvedValue([LIVE_ONLY_MODEL]);

		await fetchCursorDynamicModels("cache-key");
		await fetchCursorDynamicModels("cache-key");

		expect(mockedList).toHaveBeenCalledTimes(2);
	});

	it("hydrates live-only selection metadata before OMP restores its SQLite catalog", async () => {
		mockedList.mockResolvedValueOnce([LIVE_ONLY_MODEL]);
		await fetchCursorDynamicModels("cache-key");
		__testUtils.registerModelItems([]);
		expect(getCursorModelMetadata("future-model")).toBeUndefined();

		await getCursorFallbackModels();

		expect(buildCursorModelSelection("future-model", Effort.Low, { fastEnabled: true })).toEqual({
			id: "future-model",
			params: [
				{ id: "effort", value: "low" },
				{ id: "fast", value: "true" },
			],
		});
		expect(mockedList).toHaveBeenCalledOnce();
	});

	it("keeps successful discovery when metadata-cache persistence fails", async () => {
		const badAgentDir = join(tmpAgentDir, "not-a-directory");
		writeFileSync(badAgentDir, "file");
		process.env.PI_CODING_AGENT_DIR = badAgentDir;
		mockedList.mockResolvedValueOnce([LIVE_ONLY_MODEL]);

		const models = await fetchCursorDynamicModels("cache-key");

		expect(models.some((model) => model.id === "future-model")).toBe(true);
	});

	it("throws discovery failures so OMP can retain its last good SQLite catalog", async () => {
		mockedList.mockRejectedValueOnce(new Error("network down"));

		await expect(fetchCursorDynamicModels("cache-key")).rejects.toThrow(
			"Cursor SDK model discovery failed: network down",
		);
	});
});

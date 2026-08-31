import type { Mock } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effort } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
	__testUtils,
	buildCursorModelSelection,
	fetchCursorDynamicModels,
	getCursorFallbackModels,
	getCursorModelMetadata,
	getCursorModelMetadataEntries,
} from "../src/model-discovery.js";
import { saveCachedContextWindow, __testUtils as contextWindowCacheTestUtils } from "../src/context-window-cache.js";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

vi.mock("@cursor/sdk", () => ({
	Cursor: {
		models: {
			list: vi.fn(),
		},
	},
}));

import { Cursor } from "@cursor/sdk";
import type { ModelListItem } from "@cursor/sdk";

const mockedList = Cursor.models.list as Mock<typeof Cursor.models.list>;

function register(items: ModelListItem[]) {
	return __testUtils.registerModelItems(items);
}

describe("Cursor model catalog materialization", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;
	let tmpAgentDir: string;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-discovery-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		process.argv = ["node", "vitest"];
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
		process.argv = originalArgv;
		vi.clearAllMocks();
	});

	it("materializes generated fallback models without network auth", async () => {
		const models = await getCursorFallbackModels();
		const modelIds = models.map((model) => model.id);

		expect(modelIds).toEqual(
			expect.arrayContaining([
				"composer-2.5",
				"grok-4.6",
				"gpt-5.5",
			]),
		);
		expect(modelIds).not.toContain("gpt-5.5@272k");
		expect(modelIds.length).toBeGreaterThan(20);
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("leaves unauthenticated dynamic discovery empty and ignores process arguments", async () => {
		process.argv = [
			"node", "omp", "--model", "cursor-sdk/final", "--api-key", "argv-key",
		];

		await expect(fetchCursorDynamicModels()).resolves.toEqual([]);
		expect(mockedList).not.toHaveBeenCalled();
	});

	it("uses a trimmed provider-scoped key", async () => {
		mockedList.mockResolvedValueOnce([
			{ id: "composer-2", displayName: "Composer 2", variants: [{ params: [], displayName: "Composer 2", isDefault: true }] },
		]);

		const models = await fetchCursorDynamicModels(" explicit-key ");

		expect(mockedList).toHaveBeenCalledWith({ apiKey: "explicit-key" });
		expect(models.map((model) => model.id)).toEqual(["composer-2"]);
	});

	it("uses CURSOR_API_KEY and sorts the live SDK catalog by base id", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "model-b",
				displayName: "Model B",
				variants: [{ params: [], displayName: "Model B", isDefault: true }],
			},
			{
				id: "model-a",
				displayName: "Model A",
				variants: [{ params: [], displayName: "Model A", isDefault: true }],
			},
		]);

		const models = await fetchCursorDynamicModels();

		expect(mockedList).toHaveBeenCalledWith({ apiKey: "test-key-123" });
		expect(models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		expect(models[0].name).toBe("Model A");
	});

	it("sorts models while preserving explicit variants for non-converged context catalogs", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "z-model",
				displayName: "Z Model",
				parameters: [{ id: "context", displayName: "Context", values: [{ value: "long" }, { value: "short" }] }],
				variants: [{ params: [{ id: "context", value: "short" }], displayName: "Z Model", isDefault: true }],
			},
			{
				id: "a-model",
				displayName: "A Model",
				parameters: [{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "600k" }, { value: "1m" }] }],
				variants: [{ params: [{ id: "context", value: "1m" }], displayName: "A Model", isDefault: true }],
			},
		]);

		const models = await fetchCursorDynamicModels();

		expect(models.map((model) => model.id)).toEqual([
			"a-model",
			"a-model@300k",
			"a-model@600k",
			"z-model",
			"z-model@long",
		]);
		expect(getCursorModelMetadata("a-model@300k")?.defaultParams).toEqual([{ id: "context", value: "300k" }]);
		expect(getCursorModelMetadata("a-model@600k")?.defaultParams).toEqual([{ id: "context", value: "600k" }]);
		expect(getCursorModelMetadata("z-model@long")?.defaultParams).toEqual([{ id: "context", value: "long" }]);
	});

	it("registers only canonical SDK IDs and converges exactly two ordered context tiers", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.5",
				displayName: "GPT-5.5",
				aliases: ["gpt-latest", "gpt-latest", ""],
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "none" }, { value: "medium" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
						],
						displayName: "GPT-5.5",
						isDefault: true,
					},
				],
			},
		]);

		const models = await fetchCursorDynamicModels();

		expect(models.map((model) => model.id)).toEqual(["gpt-5.5"]);
		expect(models[0]?.cost).toMatchObject({
			longContext: { inputThreshold: 272_000 },
		});
		expect(getCursorModelMetadata("gpt-latest")).toBeUndefined();
		expect(getCursorModelMetadata("gpt-latest@272k")).toBeUndefined();
		expect(getCursorModelMetadata("gpt-5.5@272k")).toBeUndefined();
		expect(getCursorModelMetadata("gpt-5.5")).toMatchObject({
			baseModelId: "gpt-5.5",
			extendedContext: {
				standardValue: "272k",
				extendedValue: "1m",
				standardContextWindow: 272_000,
			},
		});
		expect(buildCursorModelSelection("gpt-5.5", Effort.Medium, {
			extendedContextEnabled: false,
		})).toEqual({
			id: "gpt-5.5",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "medium" },
			],
		});
	});

	it("keeps speed out of identity while native extended context controls the two context tiers", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "272k" }, { value: "1m" }] },
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [{ value: "none" }, { value: "medium" }],
					},
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
							{ id: "fast", value: "false" },
						],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models.map((model) => model.id)).toEqual(["gpt-5.4"]);
		expect(models.map((model) => model.contextWindow)).toEqual([1_000_000]);
		expect(models.map((model) => model.name)).toEqual(["GPT-5.4"]);

		const metadata = getCursorModelMetadata("gpt-5.4");
		expect(metadata).toMatchObject({
			baseModelId: "gpt-5.4",
			supportsFast: true,
			defaultFast: false,
			extendedContext: {
				standardValue: "272k",
				extendedValue: "1m",
				standardContextWindow: 272_000,
			},
		});
		expect(metadata).not.toHaveProperty("context");
		expect(metadata?.defaultParams).toEqual([
			{ id: "context", value: "1m" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "false" },
		]);
		expect(getCursorModelMetadata("gpt-5.4@fast")).toBeUndefined();
		expect(getCursorModelMetadata("gpt-5.4@272k")).toBeUndefined();
		expect(buildCursorModelSelection("gpt-5.4", Effort.Medium, {
			fastEnabled: true,
			extendedContextEnabled: false,
		})).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "medium" },
				{ id: "fast", value: "true" },
			],
		});
		expect(buildCursorModelSelection("gpt-5.4", Effort.Medium, {
			fastEnabled: false,
			extendedContextEnabled: true,
		})).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "1m" },
				{ id: "reasoning", value: "medium" },
				{ id: "fast", value: "false" },
			],
		});
	});

	it("maps OMP's native extendedContext setting onto a converged SDK context", () => {
		const [model] = register([
			{
				id: "two-tier-model",
				displayName: "Two Tier Model",
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "256k" }, { value: "1m" }] },
				],
				variants: [
					{
						params: [{ id: "context", value: "256k" }],
						displayName: "Two Tier Model",
						isDefault: true,
					},
				],
			},
		]);
		expect(model).toMatchObject({
			id: "two-tier-model",
			contextWindow: 1_000_000,
			cost: { longContext: { inputThreshold: 256_000 } },
		});

		const nativeSettings = Settings.isolated();
		expect(buildCursorModelSelection("two-tier-model", "off", {
			extendedContextEnabled: nativeSettings.get("extendedContext"),
		})).toEqual({
			id: "two-tier-model",
			params: [{ id: "context", value: "256k" }],
		});

		nativeSettings.set("extendedContext", true);
		expect(buildCursorModelSelection("two-tier-model", "off", {
			extendedContextEnabled: nativeSettings.get("extendedContext"),
		})).toEqual({
			id: "two-tier-model",
			params: [{ id: "context", value: "1m" }],
		});
	});

	it("does not encode reasoning, effort, or thinking into pi model IDs", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.3-codex",
				displayName: "GPT-5.3 Codex",
				parameters: [
					{ id: "reasoning", displayName: "Reasoning", values: [{ value: "high" }] },
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "reasoning", value: "high" },
							{ id: "fast", value: "true" },
						],
						displayName: "GPT-5.3 Codex",
						isDefault: true,
					},
				],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models.map((model) => model.id)).toEqual(["gpt-5.3-codex"]);
		expect(getCursorModelMetadata("gpt-5.3-codex")?.defaultParams).toEqual([
			{ id: "reasoning", value: "high" },
			{ id: "fast", value: "true" },
		]);
	});

	it("uses bundled SDK-derived context windows for models without context params", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-bundled-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
					variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2", isDefault: true }],
				},
				{
					id: "new-sdk-model",
					displayName: "New SDK Model",
					variants: [{ params: [], displayName: "New SDK Model", isDefault: true }],
				},
			]);

			const models = await fetchCursorDynamicModels();

			expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
				["composer-2", 200000],
				["new-sdk-model", 200000],
			]);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("loads the context-window cache once while registering a model catalog", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-count-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			contextWindowCacheTestUtils.resetUserContextWindowOverrideLoadCount();
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce(
				Array.from({ length: 25 }, (_, index) => ({
					id: `synthetic-model-${index}`,
					displayName: `Synthetic Model ${index}`,
					variants: [{ params: [], displayName: `Synthetic Model ${index}`, isDefault: true }],
				})),
			);

			await fetchCursorDynamicModels();

			expect(contextWindowCacheTestUtils.getUserContextWindowOverrideLoadCount()).toBe(1);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("lets user cache override context-qualified model IDs", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-qualified-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			saveCachedContextWindow("gpt-5.5@1m", 950000);
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "gpt-5.5",
					displayName: "GPT-5.5",
					parameters: [{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] }],
					variants: [{ params: [{ id: "context", value: "1m" }], displayName: "GPT-5.5", isDefault: true }],
				},
			]);

			const models = await fetchCursorDynamicModels();

			expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
				["gpt-5.5", 950000],
			]);
			expect(models[0]?.cost).toMatchObject({ longContext: { inputThreshold: 272000 } });
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("ignores alias evidence and preserves an ordered native context projection", () => {
		const opus = FALLBACK_MODEL_ITEMS.find(({ id }) => id === "claude-opus-4-8");
		if (!opus) throw new Error("claude-opus-4-8 fallback fixture missing");
		saveCachedContextWindow("opus-4-8@1m", 310000);

		const models = register([opus]);

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "claude-opus-4-8",
			contextWindow: 1_000_000,
			cost: { longContext: { inputThreshold: 300_000 } },
		});
		expect(models.map(({ id }) => id)).not.toContain("claude-opus-4-8@300k");
		expect(models.map(({ id }) => id)).not.toContain("opus-4.8");
		expect(models.map(({ id }) => id)).not.toContain("opus-4-8");
	});

	it("uses ordered SDK tiers when checkpoint evidence collapses both windows", () => {
		const opus = FALLBACK_MODEL_ITEMS.find(({ id }) => id === "claude-opus-4-8");
		if (!opus) throw new Error("claude-opus-4-8 fallback fixture missing");
		saveCachedContextWindow("claude-opus-4-8@1m", 300_000);

		const [model] = register([opus]);

		expect(model).toMatchObject({
			id: "claude-opus-4-8",
			contextWindow: 1_000_000,
			cost: { longContext: { inputThreshold: 300_000 } },
		});
	});

	it("lets user cache override bundled context windows", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			saveCachedContextWindow("composer-2", 201000);
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
					variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2", isDefault: true }],
				},
			]);

			const models = await fetchCursorDynamicModels();

			expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
				["composer-2", 201000],
			]);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("ignores malformed context-window cache values", async () => {
		const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-context-window-malformed-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		try {
			writeFileSync(contextWindowCacheTestUtils.getCachePath(), JSON.stringify({ contextWindows: { "composer-2": "201000" } }));
			process.env.CURSOR_API_KEY = "test-key-123";
			mockedList.mockResolvedValueOnce([
				{
					id: "composer-2",
					displayName: "Composer 2",
					variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
				},
			]);

			const models = await fetchCursorDynamicModels();

			expect(models.find((model) => model.id === "composer-2")?.contextWindow).toBe(200000);
		} finally {
			rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});

	it("sets reasoning false for models without thinking controls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gemini-3.1-pro",
				displayName: "Gemini 3.1 Pro",
				variants: [{ params: [], displayName: "Gemini 3.1 Pro", isDefault: true }],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models[0].reasoning).toBe(false);
		expect(models[0].thinking).toBeUndefined();
	});

	it("maps Cursor reasoning values to pi thinking levels", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [
							{ value: "none" },
							{ value: "minimal" },
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "extra-high" },
						],
					},
				],
				variants: [
					{
						params: [{ id: "reasoning", value: "medium" }],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models[0].thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(getCursorModelMetadata("gpt-5.4")?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "extra-high",
			max: null,
		});
	});

	it("maps boolean Cursor thinking values to off and high with explicit unsupported nulls", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-haiku-4-5",
				displayName: "Haiku 4.5",
				parameters: [
					{
						id: "thinking",
						displayName: "Thinking",
						values: [{ value: "false" }, { value: "true" }],
					},
				],
				variants: [
					{
						params: [{ id: "thinking", value: "true" }],
						displayName: "Haiku 4.5",
						isDefault: true,
					},
				],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models[0].thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High],
		});
		expect(getCursorModelMetadata("claude-haiku-4-5")?.thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: null,
			medium: null,
			high: "true",
			xhigh: null,
			max: null,
		});
	});

	it("maps Claude effort with distinct xhigh and max values", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-opus-4-7",
				displayName: "Opus 4.7",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
							{ value: "max" },
							{ value: "extra-high" },
						],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "context", value: "1m" },
							{ id: "effort", value: "xhigh" },
						],
						displayName: "Opus 4.7",
						isDefault: true,
					},
				],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models.map((model) => model.id)).toEqual(["claude-opus-4-7"]);
		expect(models[0].contextWindow).toBe(1000000);
		expect(models[0].cost).toMatchObject({ longContext: { inputThreshold: 300000 } });
		expect(models[0].thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});
		expect(getCursorModelMetadata("claude-opus-4-7")?.thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("registers text and image input for Cursor models", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "vision-capable",
				displayName: "Vision Capable",
				variants: [{ params: [], displayName: "Vision Capable", isDefault: true }],
			},
		]);

		const models = await fetchCursorDynamicModels();

		expect(models[0].input).toEqual(["text", "image"]);
	});

	it("maps reasoning off to unsupported null when Cursor exposes no none or off value", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "reasoning-only",
				displayName: "Reasoning Only",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
					},
				],
				variants: [{ params: [{ id: "reasoning", value: "medium" }], displayName: "Reasoning Only", isDefault: true }],
			},
		]);

		const models = await fetchCursorDynamicModels();

		expect(models[0].thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(getCursorModelMetadata("reasoning-only")?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(buildCursorModelSelection("reasoning-only", "off")).toEqual({
			id: "reasoning-only",
			params: [{ id: "reasoning", value: "medium" }],
		});
	});

	it("maps boolean thinking plus effort to thinking=true with effort and off to thinking=false without effort", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "claude-like",
				displayName: "Claude Like",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "effort", value: "medium" },
						],
						displayName: "Claude Like",
						isDefault: true,
					},
				],
			},
		]);

		const models = await fetchCursorDynamicModels();

		expect(models[0].thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(getCursorModelMetadata("claude-like")?.thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(buildCursorModelSelection("claude-like", Effort.High)).toEqual({
			id: "claude-like",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "effort", value: "high" },
			],
		});
		expect(buildCursorModelSelection("claude-like", "off")).toEqual({
			id: "claude-like",
			params: [{ id: "thinking", value: "false" }],
		});
	});

	it("keeps the fallback snapshot aligned with canonical Composer 2.5", async () => {
		delete process.env.CURSOR_API_KEY;

		const models = await getCursorFallbackModels();
		const modelIds = models.map((model) => model.id);

		expect(modelIds).toContain("composer-2.5");
		expect(modelIds).not.toContain("composer-2-5");
		expect(modelIds).not.toContain("composer-latest");
		expect(getCursorModelMetadata("composer-2.5")).toEqual(
			expect.objectContaining({
				baseModelId: "composer-2.5",
				contextWindow: 200000,
				supportsFast: true,
				defaultFast: true,
			}),
		);
		expect(getCursorModelMetadata("composer-2-5")).toBeUndefined();
		expect(buildCursorModelSelection("composer-2.5", "off")).toEqual({
			id: "composer-2.5",
			params: [{ id: "fast", value: "true" }],
		});
		expect(buildCursorModelSelection("composer-2.5", "off", { fastEnabled: false })).toEqual({
			id: "composer-2.5",
			params: [{ id: "fast", value: "false" }],
		});
	});

	it("surfaces a scrubbed dynamic discovery failure for OMP's cache manager", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockRejectedValueOnce(new Error("network error"));

		await expect(fetchCursorDynamicModels()).rejects.toThrow("Cursor SDK model discovery failed: network error");
	});

	it("redacts sensitive values from dynamic discovery failures", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockRejectedValueOnce(
			new Error(
				'Unauthorized Bearer test-key-123 {"apiKey":"test-key-123","token":"token-value","session_id":"session-value"} https://repo-user:repo-p@ss@example.com/org/repo.git cookie: foo=bar; baz=qux',
			),
		);

		const error = await fetchCursorDynamicModels().then(
			() => undefined,
			(reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
		);
		const message = error?.message ?? "";

		expect(message).toContain("Bearer [redacted]");
		expect(message).toContain('"apiKey":"[redacted]"');
		expect(message).toContain('"token":"[redacted]"');
		expect(message).toContain('"session_id":"[redacted]"');
		expect(message).toContain("cookie: [redacted]");
		expect(message).not.toContain("test-key-123");
		expect(message).not.toContain("token-value");
		expect(message).not.toContain("session-value");
		expect(message).not.toContain("repo-user");
		expect(message).not.toContain("repo-p");
		expect(message).not.toContain("@ss@");
		expect(message).not.toContain("foo=bar");
		expect(message).not.toContain("baz=qux");
	});

	it("returns an empty dynamic catalog when Cursor.models.list is empty", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([]);

		await expect(fetchCursorDynamicModels()).resolves.toEqual([]);
	});

	it("uses id as name when displayName is missing", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{ id: "raw-id", variants: [{ params: [], displayName: "raw-id", isDefault: true }] } as unknown as ModelListItem,
		]);
		const models = await fetchCursorDynamicModels();
		expect(models[0].name).toBe("raw-id");
	});

	it("uses first variant when no isDefault is marked", async () => {
		process.env.CURSOR_API_KEY = "test-key-123";
		mockedList.mockResolvedValueOnce([
			{
				id: "test-model",
				displayName: "Test Model",
				parameters: [{ id: "reasoning", displayName: "Reasoning", values: [{ value: "low" }, { value: "high" }] }],
				variants: [
					{ params: [{ id: "reasoning", value: "low" }], displayName: "Test Model" },
					{ params: [{ id: "reasoning", value: "high" }], displayName: "Test Model" },
				],
			},
		]);
		const models = await fetchCursorDynamicModels();
		expect(models[0].id).toBe("test-model");
		expect(buildCursorModelSelection("test-model", "off")).toEqual({
			id: "test-model",
			params: [{ id: "reasoning", value: "low" }],
		});
	});

});

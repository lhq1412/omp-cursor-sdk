import type { ModelListItem } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
	getCursorModelSelectionIdentities,
	normalizeCursorContextWindowEntries,
} from "../shared/cursor-model-selection-identities.mjs";
import { BUNDLED_CONTEXT_WINDOWS } from "../src/bundled-context-windows.js";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";
import { __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";

const models = [
	{
		id: "model-a",
		displayName: "Model A",
		aliases: ["alias-a", "shared", "model-b"],
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "1m", displayName: "1M" }, { value: "300k", displayName: "300K" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "true", displayName: "On" }, { value: "false", displayName: "Off" }] },
		],
		variants: [{ displayName: "Default", isDefault: true, params: [{ id: "context", value: "300k" }, { id: "fast", value: "false" }] }],
	},
	{ id: "model-b", displayName: "Model B", aliases: ["shared"] },
] satisfies ModelListItem[];

describe("Cursor model-selection identities", () => {
	it("matches runtime canonical base and context identities", () => {
		const identities = getCursorModelSelectionIdentities(models);
		const runtimeIds = modelDiscoveryTestUtils.registerModelItems(models).map(({ id }) => id).sort();
		expect(identities.map(({ piModelId }) => piModelId).sort()).toEqual(runtimeIds);
		expect(Object.fromEntries(identities.map(({ piModelId, contextWindowKey }) => [
			piModelId,
			contextWindowKey,
		]))).toEqual({
			"model-a": "model-a@1m",
			"model-b": "model-b",
		});
		expect(identities.find(({ piModelId }) => piModelId === "model-a")?.contextTiers).toEqual({
			standard: { value: "300k", contextWindowKey: "model-a@300k" },
			extended: { value: "1m", contextWindowKey: "model-a@1m" },
		});
	});

	it("keeps explicit variants unless exactly two ordered context sizes are available", () => {
		const identities = getCursorModelSelectionIdentities([
			{
				id: "three-tier",
				displayName: "Three Tier",
				parameters: [
					{
						id: "context",
						displayName: "Context",
						values: [{ value: "128k" }, { value: "256k" }, { value: "1m" }],
					},
				],
				variants: [
					{
						displayName: "Default",
						isDefault: true,
						params: [{ id: "context", value: "256k" }],
					},
				],
			},
			{
				id: "unordered-two-tier",
				displayName: "Unordered Two Tier",
				parameters: [
					{
						id: "context",
						displayName: "Context",
						values: [{ value: "long" }, { value: "short" }],
					},
				],
				variants: [
					{
						displayName: "Default",
						isDefault: true,
						params: [{ id: "context", value: "short" }],
					},
				],
			},
		]);

		expect(identities.map(({ piModelId }) => piModelId)).toEqual([
			"three-tier",
			"three-tier@128k",
			"three-tier@1m",
			"unordered-two-tier",
			"unordered-two-tier@long",
		]);
		expect(identities.every(({ contextTiers }) => contextTiers === undefined)).toBe(true);
	});

	it("omits SDK aliases and stale IDs while collapsing equivalent canonical entries", () => {
		const normalized = normalizeCursorContextWindowEntries(
			models,
			new Map([
				["default", 200_000],
				["model-a", 950_000],
				["model-a@300k", 300_000],
				["alias-a", 310_000],
				["model-a@slow", 999_000],
				["model-a@fast", 999_000],
				["shared", 123_000],
				["removed-model", 456_000],
			]),
		);
		expect(Object.fromEntries(normalized)).toEqual({
			default: 200_000,
			"model-a@1m": 950_000,
			"model-a@300k": 300_000,
		});
	});

	it("rejects conflicting windows for equivalent selections", () => {
		expect(() =>
			normalizeCursorContextWindowEntries(
				models,
				new Map([
					["model-a", 1_000_000],
					["model-a@1m", 300_000],
				]),
				"checkpoint input",
			),
		).toThrow("checkpoint input assigns conflicting windows to equivalent selection model-a@1m");
	});

	it("keeps every bundled key canonical context evidence for the fallback catalog", () => {
		const bundled = new Map(Object.entries(BUNDLED_CONTEXT_WINDOWS));
		expect(normalizeCursorContextWindowEntries(FALLBACK_MODEL_ITEMS, bundled, "bundled snapshot")).toEqual(bundled);
	});
});

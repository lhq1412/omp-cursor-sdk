import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import {
	__testUtils,
	fingerprintApiKey,
	isModelCacheDisabled,
	loadCachedModelCatalogForMetadata,
	saveModelListCache,
} from "../src/model-list-cache.js";

const MODELS: ModelListItem[] = [
	{
		id: "composer-2",
		displayName: "Composer 2",
		variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
	},
];

describe("Cursor selection-metadata cache", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string;
	const fingerprint = fingerprintApiKey("test-key");

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env[__testUtils.DISABLE_ENV_VAR];
		tmpAgentDir = mkdtempSync(join(tmpdir(), "omp-cursor-model-metadata-"));
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	});

	afterEach(() => {
		rmSync(tmpAgentDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	it("round-trips a validated raw SDK catalog for cold-start hydration", () => {
		expect(saveModelListCache(fingerprint, MODELS)).toBe(true);
		expect(loadCachedModelCatalogForMetadata()?.models).toEqual(MODELS);
	});

	it("writes 0600 data without the API key", () => {
		saveModelListCache(fingerprint, MODELS);
		const path = __testUtils.getCachePath();
		const text = readFileSync(path, "utf8");

		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(text).not.toContain("test-key");
		expect(text).toContain(fingerprint);
	});

	it("tightens permissions when rewriting an existing loose file", () => {
		const path = __testUtils.getCachePath();
		writeFileSync(path, "{}", { mode: 0o644 });

		expect(saveModelListCache(fingerprint, MODELS)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it.each([
		["corrupt JSON", "{ not json"],
		["invalid timestamp", JSON.stringify({ version: 1, fetchedAt: -1, keyFingerprint: fingerprint, models: MODELS })],
		["future timestamp", JSON.stringify({ version: 1, fetchedAt: Date.now() + 10 * 60 * 1000, keyFingerprint: fingerprint, models: MODELS })],
		["missing fingerprint", JSON.stringify({ version: 1, fetchedAt: Date.now(), models: MODELS })],
		["invalid model", JSON.stringify({ version: 1, fetchedAt: Date.now(), keyFingerprint: fingerprint, models: [{ id: "bad", variants: "no" }] })],
	])("ignores %s", (_label, content) => {
		writeFileSync(__testUtils.getCachePath(), content);
		expect(loadCachedModelCatalogForMetadata()).toBeUndefined();
	});

	it("disables metadata-cache reads and writes explicitly", () => {
		process.env[__testUtils.DISABLE_ENV_VAR] = "1";

		expect(isModelCacheDisabled()).toBe(true);
		expect(saveModelListCache(fingerprint, MODELS)).toBe(false);
		expect(loadCachedModelCatalogForMetadata()).toBeUndefined();
	});
});

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ModelListItem } from "@cursor/sdk";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { asRecord } from "./cursor-record-utils.js";

const MODEL_LIST_CACHE_FILE = "cursor-sdk-model-list.json";
const MODEL_LIST_CACHE_VERSION = 1;
const MAX_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DISABLE_ENV_VAR = "PI_CURSOR_SDK_DISABLE_MODEL_CACHE";

interface ModelListCacheFile {
	version: number;
	fetchedAt: number;
	keyFingerprint: string;
	models: ModelListItem[];
}

export interface CachedModelList {
	fetchedAt: number;
	models: ModelListItem[];
}

function getCachePath(): string {
	return join(getAgentDir(), MODEL_LIST_CACHE_FILE);
}

export function isModelCacheDisabled(): boolean {
	return parseEnvBoolean(process.env[DISABLE_ENV_VAR], false);
}


// Retain a non-secret key fingerprint in the metadata cache for provenance;
// selection hydration never returns it or uses it as an auth source.
export function fingerprintApiKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isModelParameterValue(value: unknown): value is NonNullable<ModelListItem["variants"]>[number]["params"][number] {
	const record = asRecord(value);
	return record !== undefined && typeof record.id === "string" && typeof record.value === "string";
}

function isModelParameterDefinitionValue(value: unknown): value is NonNullable<ModelListItem["parameters"]>[number]["values"][number] {
	const record = asRecord(value);
	return record !== undefined && typeof record.value === "string" && (record.displayName === undefined || typeof record.displayName === "string");
}

function isModelParameterDefinition(value: unknown): value is NonNullable<ModelListItem["parameters"]>[number] {
	const record = asRecord(value);
	if (!record) return false;
	return (
		typeof record.id === "string" &&
		(record.displayName === undefined || typeof record.displayName === "string") &&
		Array.isArray(record.values) &&
		record.values.every(isModelParameterDefinitionValue)
	);
}

function isModelVariant(value: unknown): value is NonNullable<ModelListItem["variants"]>[number] {
	const record = asRecord(value);
	if (!record) return false;
	return (
		Array.isArray(record.params) &&
		record.params.every(isModelParameterValue) &&
		typeof record.displayName === "string" &&
		(record.description === undefined || typeof record.description === "string") &&
		(record.isDefault === undefined || typeof record.isDefault === "boolean")
	);
}

function isModelListItem(value: unknown): value is ModelListItem {
	const record = asRecord(value);
	if (!record) return false;
	return (
		typeof record.id === "string" &&
		typeof record.displayName === "string" &&
		(record.description === undefined || typeof record.description === "string") &&
		(record.aliases === undefined || isStringArray(record.aliases)) &&
		(record.parameters === undefined || (Array.isArray(record.parameters) && record.parameters.every(isModelParameterDefinition))) &&
		(record.variants === undefined || (Array.isArray(record.variants) && record.variants.every(isModelVariant)))
	);
}

function isValidFetchedAt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + MAX_CACHE_CLOCK_SKEW_MS;
}

function parseModelListCacheFile(value: unknown): ModelListCacheFile | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (
		record.version !== MODEL_LIST_CACHE_VERSION ||
		!isValidFetchedAt(record.fetchedAt) ||
		typeof record.keyFingerprint !== "string" ||
		!Array.isArray(record.models) ||
		!record.models.every(isModelListItem)
	) {
		return undefined;
	}
	return {
		version: record.version,
		fetchedAt: record.fetchedAt,
		keyFingerprint: record.keyFingerprint,
		models: record.models,
	};
}

function readCacheFile(): ModelListCacheFile | undefined {
	const path = getCachePath();
	if (!existsSync(path)) return undefined;
	try {
		return parseModelListCacheFile(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}


// Runtime model discovery is cached by OMP independently. Hydrate Cursor
// selection metadata from the last validated raw SDK catalog even before OMP
// decides whether its own provider cache needs a network fetch. The cache
// contains model definitions only; the API-key fingerprint is never returned.
export function loadCachedModelCatalogForMetadata(): CachedModelList | undefined {
	if (isModelCacheDisabled()) return undefined;
	const cache = readCacheFile();
	return cache ? { fetchedAt: cache.fetchedAt, models: cache.models } : undefined;
}

export function saveModelListCache(keyFingerprint: string, models: ModelListItem[]): boolean {
	if (isModelCacheDisabled()) return false;
	try {
		const path = getCachePath();
		mkdirSync(dirname(path), { recursive: true });
		const data: ModelListCacheFile = {
			version: MODEL_LIST_CACHE_VERSION,
			fetchedAt: Date.now(),
			keyFingerprint,
			models,
		};
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return true;
	} catch {
		return false;
	}
}

export const __testUtils = {
	getCachePath,
	DISABLE_ENV_VAR,
};

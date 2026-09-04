import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";

import type {
	ModelListItem,
	ModelParameterDefinition,
	ModelParameterValue,
	ModelSelection,
} from "@cursor/sdk";
import { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import {
	getCursorModelSelectionIdentities,
	parseCursorContextWindowValue,
	type CursorTwoTierContextPolicy,
} from "../shared/cursor-model-selection-identities.mjs";
import { FALLBACK_MODEL_ITEMS } from "./cursor-fallback-models.generated.js";
import { loadContextWindowCache } from "./context-window-cache.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { resolveCursorApiKey, resolveCursorRuntimeApiKey } from "./cursor-api-key.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	fingerprintApiKey,
	loadCachedModelCatalogForMetadata,
	saveModelListCache,
} from "./model-list-cache.js";

// Cursor's SDK catalog publishes provider parameter values. Keep the wire map
// in selection metadata while exposing OMP's canonical effort capabilities on
// each registered model.
type ModelThinkingLevel = "off" | Effort;
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
const OMP_THINKING_EFFORTS = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
] as const;

function getSupportedThinkingEfforts(
	thinkingLevelMap: ThinkingLevelMap | undefined,
): Effort[] {
	if (!thinkingLevelMap) return [];
	return OMP_THINKING_EFFORTS.filter((effort) => thinkingLevelMap[effort] != null);
}

const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 16384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TEXT_AND_IMAGE_INPUT: ProviderModelConfig["input"] = ["text", "image"];

async function getDiscoveryApiKey(apiKey?: string): Promise<string | undefined> {
	return resolveCursorApiKey(apiKey) ?? resolveCursorRuntimeApiKey();
}

export interface CursorModelMetadata {
	piModelId: string;
	baseModelId: string;
	displayName: string;
	defaultParams: ModelParameterValue[];
	context?: string;
	extendedContext?: {
		standardValue: string;
		extendedValue: string;
		standardContextWindow: number;
	};
	contextWindow: number;
	supportsFast: boolean;
	defaultFast: boolean;
	supportsReasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	parameterIds: {
		context: boolean;
		reasoning: boolean;
		effort: boolean;
		thinking: boolean;
		fast: boolean;
	};
}

/**
 * OMP catalog authority for Cursor tool-schema combiner projection.
 * Uses resolveModelPolicy(provider: "cursor") — never request-path model-id heuristics.
 */
export function modelRequiresCursorToolSchemaProjection(modelId: string): boolean {
	const trimmed = modelId.trim();
	if (!trimmed) return false;
	try {
		const policy = resolveModelPolicy({
			id: trimmed,
			name: trimmed,
			provider: "cursor",
			api: "cursor",
			baseUrl: "https://cursor.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		return policy.catalog.requiresCursorToolSchemaProjection === true;
	} catch {
		return false;
	}
}


const metadataByPiModelId = new Map<string, CursorModelMetadata>();

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
	return params.map((param) => ({ ...param }));
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
	return item.parameters?.find((parameter) => parameter.id === id);
}

function hasBooleanValues(parameter: ModelParameterDefinition | undefined): boolean {
	const values = new Set((parameter?.values ?? []).map((value) => value.value.toLowerCase()));
	return values.has("false") && values.has("true");
}

function getParameterValue(parameter: ModelParameterDefinition | undefined, lowerValue: string): string | null {
	const value = parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue);
	return value?.value ?? null;
}

function getPreferredParameterValue(
	parameter: ModelParameterDefinition | undefined,
	lowerValues: string[],
): string | null {
	for (const value of lowerValues) {
		const candidate = getParameterValue(parameter, value);
		if (candidate) return candidate;
	}
	return null;
}

function mapComparableLevel(
	parameter: ModelParameterDefinition | undefined,
	level: Exclude<ModelThinkingLevel, "off">,
): string | null {
	if (level === "xhigh") {
		return getPreferredParameterValue(parameter, ["xhigh", "extra-high"]);
	}
	return getParameterValue(parameter, level);
}

function getThinkingLevelMap(item: ModelListItem): ThinkingLevelMap | undefined {
	const reasoningParameter = getParameter(item, "reasoning");
	const effortParameter = getParameter(item, "effort");
	const thinkingParameter = getParameter(item, "thinking");
	const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
	if (!valueParameter) return undefined;

	if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
		return {
			off: getParameterValue(valueParameter, "false"),
			minimal: null,
			low: null,
			medium: null,
			high: getParameterValue(valueParameter, "true"),
			xhigh: null,
			max: null,
		};
	}

	return {
		off:
			getParameterValue(reasoningParameter, "none") ??
			getParameterValue(reasoningParameter, "off") ??
			getParameterValue(thinkingParameter, "false"),
		minimal: mapComparableLevel(valueParameter, Effort.Minimal),
		low: mapComparableLevel(valueParameter, Effort.Low),
		medium: mapComparableLevel(valueParameter, Effort.Medium),
		high: mapComparableLevel(valueParameter, Effort.High),
		xhigh: mapComparableLevel(valueParameter, Effort.XHigh),
		max: mapComparableLevel(valueParameter, Effort.Max),
	};
}


function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
	if (!item.variants?.length) return [];
	const defaultVariant = item.variants.find((variant) => variant.isDefault) ?? item.variants[0];
	return cloneParams(defaultVariant?.params ?? []);
}

function replaceParam(
	params: ModelParameterValue[],
	id: string,
	value: string,
): ModelParameterValue[] {
	let replaced = false;
	const next = params.map((param) => {
		if (param.id !== id) return { ...param };
		replaced = true;
		return { id, value };
	});
	if (!replaced) next.push({ id, value });
	return next;
}

function getParamValue(params: ModelParameterValue[], id: string): string | undefined {
	return params.find((param) => param.id === id)?.value;
}

function getModelName(item: ModelListItem, context?: string): string {
	const displayName = item.displayName || item.id;
	return context ? `${displayName} @ ${context}` : displayName;
}

function getContextWindow(
	contextWindowCache: Map<string, number>,
	selectionKeys: readonly string[],
	context?: string,
	baseModelId?: string,
): number {
	for (const key of new Set(selectionKeys)) {
		const contextWindow = contextWindowCache.get(key);
		if (contextWindow !== undefined) return contextWindow;
	}
	return (
		(context ? parseCursorContextWindowValue(context) : undefined) ??
		(baseModelId ? contextWindowCache.get(baseModelId) : undefined) ??
		contextWindowCache.get("default") ??
		FALLBACK_CONTEXT_WINDOW
	);
}

function getTwoTierContextWindows(
	contextWindowCache: Map<string, number>,
	item: ModelListItem,
	contextTiers: CursorTwoTierContextPolicy,
	extendedContextWindowKeys: readonly string[],
): { standard: number; extended: number } {
	const resolvedStandard = getContextWindow(
		contextWindowCache,
		[contextTiers.standard.contextWindowKey],
		contextTiers.standard.value,
		item.id,
	);
	const resolvedExtended = getContextWindow(
		contextWindowCache,
		extendedContextWindowKeys,
		contextTiers.extended.value,
		item.id,
	);
	if (resolvedStandard < resolvedExtended) {
		return { standard: resolvedStandard, extended: resolvedExtended };
	}

	// Equal or inverted checkpoint evidence cannot drive OMP's boolean context
	// projection. The identity policy already proved both catalog values are
	// parseable and ordered, so retain that SDK-declared tier boundary.
	return {
		standard: parseCursorContextWindowValue(contextTiers.standard.value) ?? resolvedStandard,
		extended: parseCursorContextWindowValue(contextTiers.extended.value) ?? resolvedExtended,
	};
}

function toMetadata(
	item: ModelListItem,
	piModelId: string,
	defaultParams: ModelParameterValue[],
	context: string | undefined,
	contextTiers: CursorTwoTierContextPolicy | undefined,
	contextWindowCache: Map<string, number>,
	contextWindowKeys: readonly string[],
): CursorModelMetadata {
	const thinkingLevelMap = getThinkingLevelMap(item);
	const supportedThinkingEfforts = getSupportedThinkingEfforts(thinkingLevelMap);
	const effectiveContext = context ?? contextTiers?.extended.value ?? getParamValue(defaultParams, "context");
	const fastValue = getParamValue(defaultParams, "fast")?.toLowerCase();
	const contextWindows = contextTiers
		? getTwoTierContextWindows(contextWindowCache, item, contextTiers, contextWindowKeys)
		: undefined;
	const extendedContext = contextTiers && contextWindows
		? {
				standardValue: contextTiers.standard.value,
				extendedValue: contextTiers.extended.value,
				standardContextWindow: contextWindows.standard,
			}
		: undefined;
	return {
		piModelId,
		baseModelId: item.id,
		displayName: item.displayName || item.id,
		defaultParams: cloneParams(defaultParams),
		...(context ? { context } : {}),
		...(extendedContext ? { extendedContext } : {}),
		contextWindow:
			contextWindows?.extended ??
			getContextWindow(contextWindowCache, contextWindowKeys, effectiveContext, item.id),
		supportsFast: getParameter(item, "fast") !== undefined,
		defaultFast: fastValue === "true",
		supportsReasoning: supportedThinkingEfforts.length > 0,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		parameterIds: {
			context: getParameter(item, "context") !== undefined,
			reasoning: getParameter(item, "reasoning") !== undefined,
			effort: getParameter(item, "effort") !== undefined,
			thinking: getParameter(item, "thinking") !== undefined,
			fast: getParameter(item, "fast") !== undefined,
		},
	};
}

function toModelConfig(metadata: CursorModelMetadata, name: string): ProviderModelConfig {
	const cost = metadata.extendedContext
		? {
				...ZERO_COST,
				longContext: {
					...ZERO_COST,
					inputThreshold: metadata.extendedContext.standardContextWindow,
				},
			}
		: { ...ZERO_COST };
	return {
		id: metadata.piModelId,
		name,
		reasoning: metadata.supportsReasoning,
		...(metadata.supportsReasoning && metadata.thinkingLevelMap
			? {
					thinking: {
						mode: "effort",
						efforts: getSupportedThinkingEfforts(metadata.thinkingLevelMap),
					},
				}
			: {}),
		input: [...TEXT_AND_IMAGE_INPUT],
		cost,
		contextWindow: metadata.contextWindow,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

function registerModelItems(items: ModelListItem[], clearMetadata = true): ProviderModelConfig[] {
	if (clearMetadata) metadataByPiModelId.clear();
	const contextWindowCache = loadContextWindowCache();
	return getCursorModelSelectionIdentities(items).map(
		({ model: item, context, contextTiers, piModelId, contextWindowKey }) => {
			const defaultParams = getDefaultParams(item);
			const params = context ? replaceParam(defaultParams, "context", context) : defaultParams;
			const metadata = toMetadata(
				item,
				piModelId,
				params,
				context,
				contextTiers,
				contextWindowCache,
				[piModelId, contextWindowKey],
			);
			metadataByPiModelId.set(piModelId, metadata);
			return toModelConfig(metadata, getModelName(item, context));
		},
	);
}

export function getCursorModelMetadata(modelId: string): CursorModelMetadata | undefined {
	return metadataByPiModelId.get(modelId);
}

export function getCursorModelMetadataEntries(): CursorModelMetadata[] {
	return [...metadataByPiModelId.values()].map((metadata) => ({
		...metadata,
		defaultParams: cloneParams(metadata.defaultParams),
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
		...(metadata.extendedContext ? { extendedContext: { ...metadata.extendedContext } } : {}),
		parameterIds: { ...metadata.parameterIds },
	}));
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
	const existing = params.find((param) => param.id === id);
	if (existing) {
		existing.value = value;
	} else {
		params.push({ id, value });
	}
}

function deleteParam(params: ModelParameterValue[], id: string): void {
	const index = params.findIndex((param) => param.id === id);
	if (index >= 0) params.splice(index, 1);
}

function applyThinkingLevel(
	metadata: CursorModelMetadata,
	params: ModelParameterValue[],
	level: ModelThinkingLevel,
): void {
	const mapped = metadata.thinkingLevelMap?.[level];
	if (mapped === undefined || mapped === null) return;

	if (level === "off") {
		if (metadata.parameterIds.thinking && mapped === "false") {
			setParam(params, "thinking", mapped);
			deleteParam(params, "effort");
			return;
		}
		if (metadata.parameterIds.reasoning) {
			setParam(params, "reasoning", mapped);
		}
		return;
	}

	if (metadata.parameterIds.effort) {
		if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
		setParam(params, "effort", mapped);
		return;
	}

	if (metadata.parameterIds.reasoning) {
		setParam(params, "reasoning", mapped);
		return;
	}

	if (metadata.parameterIds.thinking) {
		setParam(params, "thinking", mapped);
	}
}

export interface CursorModelSelectionRuntimeOptions {
	fastEnabled?: boolean;
	extendedContextEnabled?: boolean;
}

export function buildCursorModelSelection(
	modelId: string,
	thinkingLevel: ModelThinkingLevel,
	runtimeOptions: CursorModelSelectionRuntimeOptions = {},
): ModelSelection {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata) return { id: modelId };

	const params = cloneParams(metadata.defaultParams);
	if (metadata.extendedContext && runtimeOptions.extendedContextEnabled !== undefined) {
		setParam(
			params,
			"context",
			runtimeOptions.extendedContextEnabled
				? metadata.extendedContext.extendedValue
				: metadata.extendedContext.standardValue,
		);
	}
	applyThinkingLevel(metadata, params, thinkingLevel);

	if (metadata.supportsFast && runtimeOptions.fastEnabled !== undefined) {
		setParam(params, "fast", runtimeOptions.fastEnabled ? "true" : "false");
	}

	return params.length > 0 ? { id: metadata.baseModelId, params } : { id: metadata.baseModelId };
}

function sanitizeDiscoveryError(error: unknown, apiKey: string): string | undefined {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return scrubSensitiveText(message, apiKey).trim() || undefined;
}


export async function getCursorFallbackModels(): Promise<ProviderModelConfig[]> {
	const models = registerModelItems(FALLBACK_MODEL_ITEMS);
	const cachedCatalog = loadCachedModelCatalogForMetadata();
	if (cachedCatalog?.models.length) registerModelItems(cachedCatalog.models, false);
	return models;
}

export async function fetchCursorDynamicModels(apiKey?: string): Promise<readonly ProviderModelConfig[]> {
	const resolvedApiKey = await getDiscoveryApiKey(apiKey);
	if (!resolvedApiKey) return [];

	try {
		const { Cursor } = await loadCursorSdk();
		const models = await Cursor.models.list({ apiKey: resolvedApiKey });
		if (models.length === 0) return [];
		saveModelListCache(fingerprintApiKey(resolvedApiKey), models);
		return registerModelItems(models);
	} catch (error) {
		const detail = sanitizeDiscoveryError(error, resolvedApiKey);
		throw new Error(`Cursor SDK model discovery failed${detail ? `: ${detail}` : "."}`);
	}
}


export const __testUtils = {
	parseContextWindow: parseCursorContextWindowValue,
	registerModelItems,
	normalizeApiKey: resolveCursorApiKey,
};

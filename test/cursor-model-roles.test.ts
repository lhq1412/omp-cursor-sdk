import { serviceTierFamily, type Api, type Model } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "vitest";
import { getCursorFallbackModels } from "../src/model-discovery.js";
import { makeHarnessModel } from "./helpers/pi-harness.js";

type ModelRoleLookup = {
	getModelRole(role: string): string | undefined;
};

type ParsedModelResult = {
	model?: Model<Api>;
	explicitThinkingLevel: boolean;
};

type OmpModelResolver = {
	resolveConfiguredModelPatterns(value: string | string[] | undefined, settings?: ModelRoleLookup): string[];
	parseModelPattern(pattern: string, availableModels: Model<Api>[]): ParsedModelResult;
	filterAvailableModelsByEnabledPatterns(
		available: Model<Api>[],
		patterns: readonly string[],
		settings?: ModelRoleLookup,
	): Model<Api>[];
};

type RetryFallbackSelector = {
	raw: string;
	provider: string;
	id: string;
};

type RetryFallbackContext = {
	chains: Record<string, string[]>;
	getModelRole(role: string): string | undefined;
	modelLookup: {
		find(provider: string, id: string): Model<Api> | undefined;
		hasProvider(provider: string): boolean;
	};
};

type OmpRetryFallbackChains = {
	resolveRetryFallbackChainKey(
		context: RetryFallbackContext,
		currentSelector: string,
		currentModel?: Model<Api> | null,
		roleHint?: string,
	): string | undefined;
	findRetryFallbackCandidates(
		context: RetryFallbackContext,
		chainKey: string,
		currentSelector: string,
		currentModel?: Model<Api> | null,
	): RetryFallbackSelector[];
};

async function loadOmpModelResolver(): Promise<OmpModelResolver> {
	const relativePath = ["..", "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "config", "model-resolver.ts"].join("/");
	return await import(new URL(relativePath, import.meta.url).href) as OmpModelResolver;
}

async function loadOmpRetryFallbackChains(): Promise<OmpRetryFallbackChains> {
	const relativePath = ["..", "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "session", "retry-fallback-chains.ts"].join("/");
	return await import(new URL(relativePath, import.meta.url).href) as OmpRetryFallbackChains;
}

describe("cursor-sdk models in OMP model roles", () => {
	it("keeps cursor-sdk outside OMP's built-in /fast service-tier families", () => {
		expect(serviceTierFamily(makeHarnessModel("cursor-sdk", "cursor-sdk", "grok-4.6"))).toBeUndefined();
	});

	it("resolves OMP session and subagent roles to independent provider variants", async () => {
		const [resolver, fallbackConfigs] = await Promise.all([
			loadOmpModelResolver(),
			getCursorFallbackModels(),
		]);
		const availableModels: Model<Api>[] = fallbackConfigs.map((config) =>
			makeHarnessModel("cursor-sdk", "cursor-sdk", config.id, {
				name: config.name,
				reasoning: config.reasoning,
				input: [...config.input],
				cost: { ...config.cost },
				contextWindow: config.contextWindow,
				maxTokens: config.maxTokens,
			}),
		);
		availableModels.push(makeHarnessModel("cursor", "cursor", "grok-4.6"));
		const configuredRoles = {
			default: "cursor-sdk/composer-2.5",
			smol: "cursor-sdk/grok-4.6",
			slow: "cursor-sdk/gpt-5.5:xhigh",
			task: "cursor-sdk/grok-4.6",
			plan: "cursor-sdk/gpt-5.5:high",
		} as const;
		const roles: ModelRoleLookup = {
			getModelRole(role) {
				return configuredRoles[role as keyof typeof configuredRoles];
			},
		};

		for (const [role, expectedPattern] of Object.entries(configuredRoles)) {
			const [pattern] = resolver.resolveConfiguredModelPatterns(`@${role}`, roles);
			expect(pattern).toBe(expectedPattern);
			const resolved = resolver.parseModelPattern(pattern!, availableModels);
			expect(resolved.model?.provider).toBe("cursor-sdk");
			expect(resolved.model?.id).toBe(expectedPattern.split("/", 2)[1]!.split(":", 1)[0]);
			expect(resolved.explicitThinkingLevel).toBe(expectedPattern.includes(":"));
		}
	});

	it("lets OMP enabledModels include cursor-sdk without admitting builtin cursor", async () => {
		const resolver = await loadOmpModelResolver();
		const cursorSdkModel = makeHarnessModel("cursor-sdk", "cursor-sdk", "grok-4.6");
		const builtinCursorModel = makeHarnessModel("cursor", "cursor", "grok-4.6");
		const availableModels = [cursorSdkModel, builtinCursorModel];

		expect(
			resolver.filterAvailableModelsByEnabledPatterns(availableModels, ["cursor-sdk/*"]),
		).toEqual([cursorSdkModel]);
		expect(
			resolver.filterAvailableModelsByEnabledPatterns(availableModels, ["cursor/*"]),
		).toEqual([builtinCursorModel]);
	});

	it("never falls into builtin cursor unless the host configures that fallback explicitly", async () => {
		const fallback = await loadOmpRetryFallbackChains();
		const cursorSdkModel = makeHarnessModel("cursor-sdk", "cursor-sdk", "grok-4.6");
		const builtinCursorModel = makeHarnessModel("cursor", "cursor", "grok-4.6");
		const models: Model<Api>[] = [cursorSdkModel, builtinCursorModel];
		const modelLookup = {
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id);
			},
			hasProvider(provider: string) {
				return models.some((model) => model.provider === provider);
			},
		};
		const currentSelector = "cursor-sdk/grok-4.6";
		const noFallback: RetryFallbackContext = {
			chains: {},
			getModelRole: () => undefined,
			modelLookup,
		};
		expect(
			fallback.resolveRetryFallbackChainKey(noFallback, currentSelector, cursorSdkModel),
		).toBeUndefined();

		const explicitFallback: RetryFallbackContext = {
			...noFallback,
			chains: { "cursor-sdk/*": ["cursor/*"] },
		};
		const chainKey = fallback.resolveRetryFallbackChainKey(
			explicitFallback,
			currentSelector,
			cursorSdkModel,
		);
		expect(chainKey).toBe("cursor-sdk/*");
		expect(
			fallback.findRetryFallbackCandidates(
				explicitFallback,
				chainKey!,
				currentSelector,
				cursorSdkModel,
			),
		).toEqual([
			expect.objectContaining({
				raw: "cursor/grok-4.6",
				provider: "cursor",
				id: "grok-4.6",
			}),
		]);
	});
});

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { fetchCursorDynamicModels, getCursorFallbackModels } from "./model-discovery.js";
import { registerCursorRuntimeControls } from "./cursor-state.js";
import { registerCursorNativeToolDisplay } from "./cursor-native-tool-display-registration.js";
import { registerCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { registerCursorQuestionTool } from "./cursor-question-tool.js";
import { registerCursorSkillTool } from "./cursor-skill-tool.js";
import { registerCursorSessionScope } from "./cursor-session-scope.js";
import { registerCursorSessionAgentLifecycle } from "./cursor-session-agent-lifecycle.js";
import { registerCursorSessionAgentLineage } from "./cursor-session-agent-lineage.js";
import { registerCursorSessionAgentResume } from "./cursor-session-agent-resume.js";
import { streamCursorLazy } from "./cursor-provider-lazy.js";
import {
	createCursorSdkApiKeyLogin,
	getCursorSdkProviderApiKeyConfig,
	resolveCursorApiKey,
	resolveCursorRuntimeApiKey,
} from "./cursor-api-key.js";
import { sanitizeCursorProviderError } from "./cursor-provider-errors.js";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "./cursor-model.js";
import { registerCursorAgentsContextDedup } from "./cursor-agents-context-registration.js";
import { registerCursorSdkRuntimePrewarm } from "./cursor-sdk-runtime-prewarm.js";
import { registerCursorSdkSessionProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { prepareCursorSessionForCompaction } from "./cursor-session-compaction-prep.js";

type CursorExtensionApi =
	& Pick<ExtensionAPI, "registerProvider" | "registerCommand" | "on">
	& Parameters<typeof registerCursorSessionScope>[0]
	& Parameters<typeof registerCursorSessionAgentLifecycle>[0]
	& Parameters<typeof registerCursorSessionAgentLineage>[0]
	& Parameters<typeof registerCursorSessionAgentResume>[0]
	& Parameters<typeof registerCursorRuntimeControls>[0]
	& Parameters<typeof registerCursorNativeToolDisplay>[0]
	& Parameters<typeof registerCursorQuestionTool>[0]
	& Parameters<typeof registerCursorSkillTool>[0]
	& Parameters<typeof registerCursorPiToolBridge>[0]
	& Parameters<typeof registerCursorAgentsContextDedup>[0]
	& Parameters<typeof registerCursorSdkRuntimePrewarm>[0]
	& Parameters<typeof registerCursorSdkSessionProcessErrorGuard>[0];

function createCursorProviderConfig(fallbackModels: ProviderModelConfig[]): ProviderConfig {
	const apiKey = getCursorSdkProviderApiKeyConfig();
	return {
		baseUrl: "https://cursor.com",
		...(apiKey ? { apiKey } : {}),
		api: CURSOR_SDK_API,
		oauth: createCursorSdkApiKeyLogin(),
		streamSimple: streamCursorLazy,
		fetchDynamicModels: async (resolvedApiKey) => {
			const models = await fetchCursorDynamicModels(resolvedApiKey);
			return models.length > 0 ? models : fallbackModels;
		},
	};
}

function registerCursorProvider(pi: Pick<ExtensionAPI, "registerProvider">, models: ProviderModelConfig[]): void {
	pi.registerProvider(CURSOR_SDK_PROVIDER_ID, createCursorProviderConfig(models));
}

export default async function (pi: CursorExtensionApi) {
	// Session cwd must register before other session_start listeners that depend on it.
	registerCursorSessionScope(pi);
	registerCursorSessionAgentLineage(pi);
	registerCursorSessionAgentLifecycle(pi);
	registerCursorSessionAgentResume(pi);
	pi.on("session_before_compact", async () => {
		await prepareCursorSessionForCompaction();
	});
	registerCursorRuntimeControls(pi);
	registerCursorSdkRuntimePrewarm(pi);
	registerCursorNativeToolDisplay(pi);
	registerCursorQuestionTool(pi);
	registerCursorSkillTool(pi);
	registerCursorPiToolBridge(pi);
	registerCursorAgentsContextDedup(pi);
	const models = await getCursorFallbackModels();

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor SDK model catalog through OMP",
		handler: async (_args, ctx) => {
			const apiKey =
				resolveCursorApiKey(await ctx.modelRegistry.getApiKeyForProvider(CURSOR_SDK_PROVIDER_ID))
				?? await resolveCursorRuntimeApiKey();
			if (!apiKey) {
				ctx.ui.notify(
					"Cursor SDK model refresh requires a Cursor SDK API key; run /login cursor-sdk or set CURSOR_API_KEY.",
					"error",
				);
				return;
			}
			try {
				await ctx.modelRegistry.refreshProvider(CURSOR_SDK_PROVIDER_ID, "online");
				if (ctx.hasUI) ctx.ui.notify("Cursor SDK model catalog refreshed.", "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(sanitizeCursorProviderError(error, apiKey), "error");
			}
		},
	});

	registerCursorProvider(pi, models);
	// Register last so session_shutdown cleanup remains protected until other Cursor handlers finish.
	registerCursorSdkSessionProcessErrorGuard(pi);
}

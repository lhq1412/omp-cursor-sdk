import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { AgentModeOption, ModelSelection } from "@cursor/sdk";
import { configureCursorSdkHttp1 } from "./cursor-http1.js";
import { installCursorMcpToolTimeoutOverride } from "./cursor-mcp-timeout-override.js";
import { ensureCursorRipgrepPath } from "./cursor-ripgrep-path.js";
import { installCursorSdkOutputFilter } from "./cursor-sdk-output-filter.js";
import {
	buildCursorSessionSendPrompt,
	planCursorSessionSend,
	resetSessionCursorAgent,
	type CursorSessionSendPlan,
} from "./cursor-session-agent.js";
import { sdkCursorBackend, type CursorBackendSession, type LocalCursorBackendSession } from "./cursor-backend.js";
import {
	CURSOR_OMP_EXEC_DISALLOWED_TOOLS,
	resolveCursorProviderExecHandlers,
} from "./cursor-omp-exec-adapter.js";
import type { CursorPiBridgeToolRequest } from "./cursor-pi-tool-bridge.js";
import { buildCursorPrompt, estimateCursorPromptTokens } from "./context.js";
import { getCursorPromptOptions } from "./cursor-usage-accounting.js";
import { getActiveContextToolNames } from "./cursor-context-tools.js";
import type { CursorLiveRun } from "./cursor-live-run-coordinator.js";
import {
	abandonSessionCursorAgent,
	createCursorNativeReplayId,
	cursorLiveRuns,
	getActiveCursorLiveRunForCurrentScope,
	getPendingCursorLiveRun,
} from "./cursor-provider-live-run-drain.js";
import {
	getCursorProviderAgentModeOrThrow,
	getEffectiveFastForModelId,
} from "./cursor-state.js";
import { resolveEffectiveCursorConfig } from "./cursor-runtime-state.js";
import type { CursorResolvedSdkConfig } from "./cursor-config.js";
import { buildCursorModelSelection, getCursorModelMetadata } from "./model-discovery.js";
import { getEffectiveCursorSettingSources } from "./cursor-setting-sources.js";
import {
	formatCursorCloudPreflightError,
	buildCursorCloudAgentOptions,
	preflightCursorCloudRuntime,
} from "./cursor-cloud-options.js";
import { inspectCursorCloudLocalState } from "./cursor-cloud-local-state.js";
import { getCursorSessionName, getCursorSessionProjectTrusted } from "./cursor-session-scope.js";
import { resolveCursorPiToolBridgeEnabled } from "./cursor-pi-tool-bridge-env.js";
import {
	buildCursorToolManifestText,
	resolveCursorToolManifestEnabled,
} from "./cursor-tool-manifest.js";
import { isCursorNativeToolDisplayRuntimeEnabled } from "./cursor-native-tool-display-state.js";
import {
	createCursorCloudLifecyclePersistenceError,
	recordCursorCloudLifecycleSafely,
} from "./cursor-cloud-lifecycle.js";
import { MISSING_CURSOR_API_KEY_MESSAGE } from "./cursor-provider-errors.js";
import { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import {
	isRemovedCursorApiKeyPlaceholder,
	resolveCursorApiKey,
	resolveCursorRuntimeApiKey,
	resolveCursorStringApiKey,
} from "./cursor-api-key.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import type {
	CloudCursorProviderTurnPrepareResult,
	CursorProviderTurnLifecycle,
	CursorProviderTurnPrepareResult,
	CursorProviderTurnRunnerParams,
	LocalCursorProviderTurnPrepareResult,
} from "./cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";

export interface PrepareCursorProviderTurnParams {
	params: CursorProviderTurnRunnerParams;
	cwd: string;
	resolvedApiKey: string;
	sdkEventDebug: CursorSdkEventDebugSink | undefined;
	throwIfAborted: () => void;
	/** Snapshot resolved once by the runner before draining; reused unchanged through prepare. */
	resolvedConfig: CursorResolvedSdkConfig;
}

interface PrepareCursorProviderTurnContext extends PrepareCursorProviderTurnParams {
	agentMode: AgentModeOption;
	selection: ModelSelection;
	fastEnabled: boolean | undefined;
}

function buildCursorCloudPromptContext(context: Context, handoff: "fresh" | "bootstrap" | "never"): Context {
	if (handoff === "bootstrap") return context;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role === "user") return { ...context, messages: [message] };
	}
	return { ...context, messages: context.messages.slice(-1) };
}

const CLOUD_SEND_PLAN: CursorSessionSendPlan = { mode: "bootstrap", resetAgent: false, reason: "initial" };

function isOmpExtendedContextEnabled(
	modelId: string,
	contextWindow: number | null,
): boolean {
	const standardContextWindow =
		getCursorModelMetadata(modelId)?.extendedContext?.standardContextWindow;
	// OMP clamps the effective model window to this threshold while its native
	// extended-context control is off. Per-model overrides intentionally win.
	return standardContextWindow === undefined ||
		contextWindow === null ||
		contextWindow > standardContextWindow;
}

export function resolveCursorProviderTurnConfig(cwd: string) {
	return resolveEffectiveCursorConfig({ cwd, projectTrusted: getCursorSessionProjectTrusted() });
}

function buildCloudCursorProviderTurnLifecycle(backendSession: CursorBackendSession): CursorProviderTurnLifecycle {
	return {
		trackRunCompletion: () => {},
		commitSend: () => {},
		abandon: async () => {},
		dispose: () => backendSession.dispose(),
	};
}

function buildLocalCursorProviderTurnLifecycle(
	backendSession: LocalCursorBackendSession,
): CursorProviderTurnLifecycle {
	return {
		trackRunCompletion: (completion) => backendSession.trackRunCompletion(completion),
		commitSend: (context, bootstrapped, agentMessageOffset) => backendSession.commitSend(context, bootstrapped, agentMessageOffset),
		abandon: () => abandonSessionCursorAgent(backendSession.scopeKey),
		dispose: async () => {},
	};
}

async function prepareCursorCloudProviderTurn(
	prepareParams: PrepareCursorProviderTurnContext,
): Promise<CloudCursorProviderTurnPrepareResult> {
	const { params, cwd, resolvedApiKey, sdkEventDebug, throwIfAborted, resolvedConfig, agentMode, selection, fastEnabled } = prepareParams;
	const { model, context, options } = params;

	let restoreCursorSdkOutputFilter: (() => void) | undefined;
	let cloudSessionForCleanup: CursorBackendSession | undefined;
	let completed = false;

	try {
		const preflight = preflightCursorCloudRuntime({
			resolvedConfig,
			localState: resolvedConfig.cloud.allowLocalState.value
				? { insideGitRepo: false }
				: inspectCursorCloudLocalState(cwd, {
					repo: resolvedConfig.cloud.repo.value,
					branch: resolvedConfig.cloud.branch.value,
				}),
			hasPriorContext: context.messages.length > 1,
		});
		if (!preflight.ok) throw new Error(formatCursorCloudPreflightError(preflight));
		if (getPendingCursorLiveRun(context) || getActiveCursorLiveRunForCurrentScope()) {
			throw new Error("Cursor cloud runtime cannot start while a local Cursor live run is pending; finish or abort the local run, then retry.");
		}

		restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		const promptOptions = {
			...getCursorPromptOptions(model),
			agentMode,
			includePiBridgeGuidance: false,
			includePiAskQuestionGuidance: false,
		};
		const prompt = buildCursorPrompt(
			buildCursorCloudPromptContext(context, resolvedConfig.cloud.contextHandoff.value),
			promptOptions,
		);
		const promptInputTokens = estimateCursorPromptTokens(prompt, promptOptions);
		const backendSession = await sdkCursorBackend.acquire({
			runtimeTarget: "cloud",
			options: buildCursorCloudAgentOptions({
				apiKey: resolvedApiKey,
				modelSelection: selection,
				agentMode,
				resolvedConfig,
				name: getCursorSessionName(),
			}),
		});
		cloudSessionForCleanup = backendSession;
		sdkEventDebug?.recordProviderEvent("sdk_runtime_ready", {});
		sdkEventDebug?.recordProviderEvent("agent_acquired", {
			kind: "created",
			created: true,
			resumed: false,
		});
		if (!recordCursorCloudLifecycleSafely({ agentId: backendSession.id }, resolvedApiKey)) {
			throw createCursorCloudLifecyclePersistenceError(backendSession.id, "intent", undefined, resolvedApiKey);
		}
		sdkEventDebug?.recordProviderMeta({ runtime: "cloud", cloudAgentId: backendSession.id, phase: "agent_created" });
		throwIfAborted();

		const textDeltas: string[] = [];
		const nativeReplayId = createCursorNativeReplayId();
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream: params.stream,
			partial: params.partial,
			cwd,
			resolvedApiKey,
			useNativeToolReplay: false,
			nativeReplayId,
			textDeltas,
			debugRecorder: sdkEventDebug,
		});
		sdkEventDebug?.recordProviderMeta({
			runtime: "cloud",
			cloudAgentId: backendSession.id,
			model: {
				id: model.id,
				provider: model.provider,
				api: model.api,
				reasoning: options?.reasoning ?? "off",
				fastEnabled,
				selection,
			},
			contextHandoff: resolvedConfig.cloud.contextHandoff.value,
			sendPlan: CLOUD_SEND_PLAN,
			promptOptions,
			agentMode,
			localForce: false,
		});

		completed = true;
		cloudSessionForCleanup = undefined;
		return {
			runtimeTarget: "cloud",
			backendSession,
			cwd,
			payload: {
				text: prompt.text,
				images: prompt.images.length > 0 ? prompt.images : undefined,
			},
			meta: {
				sendPlan: CLOUD_SEND_PLAN,
				prompt,
				bootstrap: true,
				promptInputTokens,
				useNativeToolReplay: false,
				bridgeEnabled: false,
				nativeReplayId,
				agentMode,
				modelSelection: selection,
			},
			textDeltas,
			restoreCursorSdkOutputFilter,
			lifecycle: buildCloudCursorProviderTurnLifecycle(backendSession),
			runtime: { kind: "direct", turnCoordinator },
		};
	} finally {
		if (!completed) {
			await cloudSessionForCleanup?.dispose().catch(() => {});
			restoreCursorSdkOutputFilter?.();
		}
	}
}

async function prepareCursorLocalProviderTurn(
	prepareParams: PrepareCursorProviderTurnContext,
): Promise<LocalCursorProviderTurnPrepareResult> {
	const { params, cwd, resolvedApiKey, sdkEventDebug, throwIfAborted, resolvedConfig, agentMode, selection, fastEnabled } = prepareParams;
	const { model, context, options } = params;
	const execHandlers = resolveCursorProviderExecHandlers(options);

	let restoreCursorSdkOutputFilter: (() => void) | undefined;
	let sessionAgentScopeKey: string | undefined;
	let liveRun: CursorLiveRun | undefined;
	let completed = false;

	try {
		ensureCursorRipgrepPath();
		const localSafety = {
			autoReview: resolvedConfig.local.autoReview.value,
			sandboxEnabled: resolvedConfig.local.sandboxEnabled.value,
		};
		const sdk = await loadCursorSdk();
		const useHttp1ForAgent = configureCursorSdkHttp1(
			sdk,
			resolvedConfig.local.useHttp1ForAgent,
		);
		sdkEventDebug?.recordProviderEvent("sdk_runtime_ready", {});

		installCursorMcpToolTimeoutOverride();
		restoreCursorSdkOutputFilter = installCursorSdkOutputFilter();
		const settingSources = getEffectiveCursorSettingSources();
		const queuedBridgeRequestsBeforeLiveRun: CursorPiBridgeToolRequest[] = [];
		let liveRunForBridgeQueue: CursorLiveRun | undefined;

		const sessionAgentAcquireParams = {
			apiKey: resolvedApiKey,
			agentMode,
			cwd,
			modelSelection: selection,
			settingSources,
			localSafety,
			localResume: resolvedConfig.local.resume.value,
			useHttp1ForAgent,
			...(execHandlers ? { disallowedTools: [...CURSOR_OMP_EXEC_DISALLOWED_TOOLS] } : {}),
			debugRecorder: sdkEventDebug,
			onBridgeToolRequest: (request: CursorPiBridgeToolRequest) => {
				if (liveRunForBridgeQueue && !liveRunForBridgeQueue.disposed) {
					cursorLiveRuns.queueEvent(liveRunForBridgeQueue, { type: "bridge-tool", request });
				} else {
					queuedBridgeRequestsBeforeLiveRun.push(request);
				}
			},
		};
		let backendSession = await sdkCursorBackend.acquire({
			runtimeTarget: "local",
			sessionAgent: sessionAgentAcquireParams,
		});
		sessionAgentScopeKey = backendSession.scopeKey;
		throwIfAborted();

		let bridgeToolNames = new Set(backendSession.bridgeRun?.snapshot.tools.map((tool) => tool.mcpToolName) ?? []);
		let includePiBridgeGuidance = bridgeToolNames.size > 0;
		const buildPromptOptions = (plan: ReturnType<typeof planCursorSessionSend>) => {
			const promptOptions = {
				...getCursorPromptOptions(model),
				agentMode,
				includePiBridgeGuidance,
				includePiAskQuestionGuidance: bridgeToolNames.has("pi__cursor_ask_question"),
			};
			if (plan.mode !== "bootstrap" || !resolveCursorToolManifestEnabled()) {
				return promptOptions;
			}
			return {
				...promptOptions,
				toolManifest: buildCursorToolManifestText({
					bridgeSnapshot: backendSession.bridgeRun?.snapshot,
					piBridgeEnabled: resolveCursorPiToolBridgeEnabled(),
					includePiBridgeGuidance,
				}),
			};
		};
		let sendPlan = planCursorSessionSend(backendSession.sendState, context);
		let promptOptions = buildPromptOptions(sendPlan);
		let prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		if (sendPlan.resetAgent) {
			await resetSessionCursorAgent(sessionAgentScopeKey);
			backendSession = await sdkCursorBackend.acquire({
				runtimeTarget: "local",
				sessionAgent: { ...sessionAgentAcquireParams, forceCreate: true },
			});
			sessionAgentScopeKey = backendSession.scopeKey;
			bridgeToolNames = new Set(backendSession.bridgeRun?.snapshot.tools.map((tool) => tool.mcpToolName) ?? []);
			includePiBridgeGuidance = bridgeToolNames.size > 0;
			sendPlan = planCursorSessionSend(backendSession.sendState, context);
			promptOptions = buildPromptOptions(sendPlan);
			prompt = buildCursorSessionSendPrompt(context, promptOptions, sendPlan);
		}
		const bootstrap = sendPlan.mode === "bootstrap";
		const bridgeRun = backendSession.bridgeRun;
		const sendPayload = {
			text: prompt.text,
			images: prompt.images.length > 0 ? prompt.images : undefined,
		};
		const sessionBridgeRun = bridgeRun;
		const promptInputTokens = estimateCursorPromptTokens(prompt, promptOptions);
		const useNativeToolReplay = isCursorNativeToolDisplayRuntimeEnabled();
		const activeToolNames = getActiveContextToolNames(context);
		sdkEventDebug?.recordProviderEvent("store_ready", {});
		sdkEventDebug?.recordProviderEvent("bridge_ready", { enabled: bridgeRun !== undefined });
		sdkEventDebug?.recordProviderEvent("agent_acquired", {
			kind: backendSession.created ? (backendSession.resumed === true ? "resumed" : "created") : "reused",
			created: backendSession.created,
			resumed: backendSession.resumed === true,
		});
		sdkEventDebug?.recordProviderMeta({
			model: {
				id: model.id,
				provider: model.provider,
				api: model.api,
				reasoning: options?.reasoning ?? "off",
				fastEnabled,
				selection,
			},
			settingSources: settingSources ?? null,
			sendState: backendSession.sendState,
			sendPlan,
			promptOptions,
			toolManifestEnabled: resolveCursorToolManifestEnabled(),
			agentMode,
			localForce: resolvedConfig.local.force.value,
			localResume: resolvedConfig.local.resume.value,
			resumedAgent: backendSession.resumed,
			activeToolNames: activeToolNames ? [...activeToolNames] : [],
			sessionAgentScopeKey,
			bridgeRunId: bridgeRun?.id,
		});
		const nativeReplayId = createCursorNativeReplayId();
		const textDeltas: string[] = [];
		const useLiveRun = useNativeToolReplay || bridgeRun !== undefined;
		liveRun = useLiveRun
			? cursorLiveRuns.start({
					id: useNativeToolReplay ? nativeReplayId : bridgeRun?.id ?? nativeReplayId,
					agentId: backendSession.id,
					bridgeRun,
					sessionBridgeRun,
					sessionAgentScopeKey,
					promptInputTokens,
					textDeltas,
					debugRecorder: sdkEventDebug,
				})
			: undefined;
		if (liveRun) {
			liveRunForBridgeQueue = liveRun;
			for (const request of queuedBridgeRequestsBeforeLiveRun.splice(0)) {
				cursorLiveRuns.queueEvent(liveRun, { type: "bridge-tool", request });
			}
		}
		const turnCoordinator = new CursorSdkTurnCoordinator({
			stream: params.stream,
			partial: params.partial,
			cwd,
			resolvedApiKey,
			liveRun,
			useNativeToolReplay,
			activeToolNames,
			nativeReplayId,
			textDeltas,
			debugRecorder: sdkEventDebug,
			ompExecEnabled: execHandlers !== undefined,
		});

		completed = true;
		return {
			runtimeTarget: "local",
			backendSession,
			cwd,
			payload: sendPayload,
			meta: {
				sendPlan,
				prompt,
				bootstrap,
				promptInputTokens,
				useNativeToolReplay,
				bridgeEnabled: bridgeRun !== undefined,
				nativeReplayId,
				agentMode,
				modelSelection: selection,
				...(backendSession.resumeNotice ? { resumeNotice: backendSession.resumeNotice } : {}),
			},
			textDeltas,
			sessionAgentScopeKey,
			localForce: resolvedConfig.local.force,
			restoreCursorSdkOutputFilter,
			lifecycle: buildLocalCursorProviderTurnLifecycle(backendSession),
			runtime: liveRun
				? { kind: "live", liveRun, turnCoordinator }
				: { kind: "direct", turnCoordinator },
		};
	} finally {
		if (!completed) {
			if (liveRun && !liveRun.disposed) {
				await cursorLiveRuns
					.release(liveRun)
					.catch(() => abandonSessionCursorAgent(sessionAgentScopeKey).catch(() => {}));
			} else {
				await abandonSessionCursorAgent(sessionAgentScopeKey).catch(() => {});
			}
			restoreCursorSdkOutputFilter?.();
		}
	}
}

/** Resolves the runtime target from the caller-supplied snapshot and dispatches to the owning branch. */
export async function prepareCursorProviderTurn(
	prepareParams: PrepareCursorProviderTurnParams,
): Promise<CursorProviderTurnPrepareResult> {
	const { params, resolvedConfig } = prepareParams;
	const { model, options } = params;

	const agentMode = getCursorProviderAgentModeOrThrow();
	const fastEnabled = resolvedConfig.runtime.value === "cloud" ? undefined : getEffectiveFastForModelId(model.id);
	const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off", {
		fastEnabled,
		extendedContextEnabled: isOmpExtendedContextEnabled(model.id, model.contextWindow),
	});
	const context: PrepareCursorProviderTurnContext = { ...prepareParams, agentMode, selection, fastEnabled };

	return resolvedConfig.runtime.value === "cloud"
		? prepareCursorCloudProviderTurn(context)
		: prepareCursorLocalProviderTurn(context);
}

export async function requireCursorApiKey(options: SimpleStreamOptions | undefined): Promise<string> {
	if (isRemovedCursorApiKeyPlaceholder(options?.apiKey)) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
	const apiKey = await resolveCursorStringApiKey(options?.apiKey) ?? await resolveCursorRuntimeApiKey();
	if (!apiKey) throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
	return apiKey;
}

import type { Context } from "@oh-my-pi/pi-ai";
import type { Run, SendOptions, SDKAgent } from "@cursor/sdk";
import { acquireSessionCursorAgent, type SessionCursorAgentCreateParams, type SessionCursorAgentSendState } from "./cursor-session-agent.js";
import type { CursorPiToolBridgeRun } from "./cursor-pi-tool-bridge.js";
import type { CursorProviderTurnSendPayload } from "./cursor-provider-turn-types.js";
import type { CursorSdkTurnUsage } from "./cursor-usage-accounting.js";
import type { CursorTranscriptReplayResult } from "./cursor-agent-message-web-tools.js";
import { getCursorAgentMessageOffset, invalidateCursorAgentMessageOffset, loadCursorTranscriptWebToolCallsAfterOffset } from "./cursor-agent-message-web-tools.js";
import { attachCursorSdkBilledTurnUsage, initializeCursorLocalBilledUsage } from "./cursor-sdk-billed-usage.js";
import { collectCursorCloudRunReport, type CursorCloudRunReport } from "./cursor-cloud-reporting.js";
import { getCheckpointContextWindow, saveCachedContextWindow } from "./context-window-cache.js";
import { loadCursorSdk, type CursorSdkModule } from "./cursor-sdk-runtime.js";
import { suppressCursorSdkOutput } from "./cursor-sdk-output-filter.js";

export type CursorBackendRun = Run;
export type CursorBackendRunResult = Awaited<ReturnType<CursorBackendRun["wait"]>>;

export interface CursorBackendSendInput {
	payload: CursorProviderTurnSendPayload;
	options?: SendOptions;
}

export interface CursorBackendSession {
	readonly id: string;
	send(input: CursorBackendSendInput): Promise<CursorBackendRun>;
	reload?(): Promise<void>;
	attachBilledTurnUsage(runId?: string): Promise<{ agentUsage?: unknown; turn?: CursorSdkTurnUsage }>;
	dispose(): Promise<void>;
}

export interface LocalCursorBackendSession extends CursorBackendSession {
	readonly scopeKey: string;
	readonly poolKey: string;
	readonly instanceId: number;
	readonly bridgeRun?: CursorPiToolBridgeRun;
	readonly sendState: SessionCursorAgentSendState;
	readonly created: boolean;
	readonly resumed?: boolean;
	readonly resumeNotice?: string;
	commitSend(context: Context, bootstrapped: boolean, agentMessageOffset?: number): void;
	trackRunCompletion(completion: Promise<unknown>): void;
	initializeBilledUsage(): Promise<boolean>;
	getMessageOffset(): number | undefined;
	invalidateMessageOffset(): void;
	loadTranscriptWebToolCallsAfterOffset(offset: number | undefined): Promise<CursorTranscriptReplayResult>;
	cacheContextWindow(modelId: string): Promise<void>;
}

export interface CloudCursorBackendSession extends CursorBackendSession {
	collectRunReport(
		run: CursorBackendRun,
		waitResult: CursorBackendRunResult,
		apiKey: string | undefined,
		agentUsage?: unknown,
	): Promise<CursorCloudRunReport>;
}

export type CursorBackendAcquireInput =
	| { runtimeTarget: "local"; sessionAgent: Omit<SessionCursorAgentCreateParams, "createAgent" | "resumeAgent"> }
	| { runtimeTarget: "cloud"; options: Parameters<CursorSdkModule["Agent"]["create"]>[0] };

export interface CursorBackend {
	acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "local" }>): Promise<LocalCursorBackendSession>;
	acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "cloud" }>): Promise<CloudCursorBackendSession>;
}

function wrapAgent(
	agent: SDKAgent,
	runtime: "local" | "cloud",
): Pick<CursorBackendSession, "id" | "send" | "reload" | "attachBilledTurnUsage"> {
	return {
		id: agent.agentId,
		send: (input) => agent.send(input.payload, input.options),
		reload: async () => {
			await agent.reload?.();
		},
		attachBilledTurnUsage: (runId) => attachCursorSdkBilledTurnUsage({ agent, agentId: agent.agentId, runtime, runId }),
	};
}

async function cacheSdkContextWindow(agentId: string, modelId: string, cwd: string, store: import("@cursor/sdk").LocalAgentStore | undefined): Promise<void> {
	try {
		const { createAgentPlatform } = await loadCursorSdk();
		const platform = await createAgentPlatform({ workspaceRef: cwd, scopedWorkspaceRef: cwd, localStore: store });
		const contextWindow = getCheckpointContextWindow(await platform.checkpointStore.loadLatest(agentId));
		if (contextWindow) saveCachedContextWindow(modelId, contextWindow);
	} catch {
		// Context-window cache failures must not affect response streaming.
	}
}

class SdkCursorBackend implements CursorBackend {
	async acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "local" }>): Promise<LocalCursorBackendSession>;
	async acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "cloud" }>): Promise<CloudCursorBackendSession>;
	async acquire(input: CursorBackendAcquireInput): Promise<LocalCursorBackendSession | CloudCursorBackendSession> {
		if (input.runtimeTarget === "local") {
			const { Agent } = await loadCursorSdk();
			const lease = await acquireSessionCursorAgent({
				...input.sessionAgent,
				createAgent: (options) => suppressCursorSdkOutput(() => Agent.create(options)),
				resumeAgent: (agentId, options) => suppressCursorSdkOutput(() => Agent.resume(agentId, options)),
			});
			const { agent, store } = lease;
			return {
				...wrapAgent(agent, "local"),
				scopeKey: lease.scopeKey,
				poolKey: lease.poolKey,
				instanceId: lease.instanceId,
				bridgeRun: lease.bridgeRun,
				sendState: lease.sendState,
				created: lease.created,
				resumed: lease.resumed,
				resumeNotice: lease.resumeNotice,
				commitSend: (context, bootstrapped, agentMessageOffset) => lease.commitSend(context, bootstrapped, agentMessageOffset),
				trackRunCompletion: (completion) => lease.trackRunCompletion(completion),
				initializeBilledUsage: () => initializeCursorLocalBilledUsage(agent, agent.agentId),
				getMessageOffset: () => getCursorAgentMessageOffset(agent),
				invalidateMessageOffset: () => invalidateCursorAgentMessageOffset(agent),
				loadTranscriptWebToolCallsAfterOffset: (offset) => loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: input.sessionAgent.cwd, offset, store }),
				cacheContextWindow: (modelId) => cacheSdkContextWindow(agent.agentId, modelId, input.sessionAgent.cwd, store),
				dispose: async () => {},
			};
		}
		const { Agent } = await loadCursorSdk();
		const agent = await suppressCursorSdkOutput(() => Agent.create(input.options));
		return {
			...wrapAgent(agent, "cloud"),
			collectRunReport: (run, waitResult, apiKey, agentUsage) => collectCursorCloudRunReport({
				access: { listArtifacts: agent.listArtifacts?.bind(agent), getUsage: agent.getUsage?.bind(agent) },
				run,
				waitResult,
				apiKey,
				agentUsage,
			}),
			dispose: async () => {
				await agent[Symbol.asyncDispose]?.();
			},
		};
	}
}

export const sdkCursorBackend: CursorBackend = new SdkCursorBackend();

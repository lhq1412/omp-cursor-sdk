import type { RunError } from "@cursor/sdk";
import type { CursorBackendRun, CursorBackendRunResult, LocalCursorBackendSession } from "./cursor-backend.js";
import {
	formatCursorCloudRunReport,
	type CursorCloudRunReport,
} from "./cursor-cloud-reporting.js";
import { recordCursorCloudLifecycleRun } from "./cursor-cloud-lifecycle.js";
import {
	getCursorContextWindowCacheKey,
} from "./context-window-cache.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type { CursorSdkTurnCoordinator } from "./cursor-provider-turn-coordinator.js";
import {
	isCursorRunFinishedSuccessfully,
	resolveCursorRunOutcome,
	type CursorRunOutcome,
} from "./cursor-provider-run-outcome.js";
import type { CursorProviderTurnPrepareResult } from "./cursor-provider-turn-types.js";

export interface BuildCursorRunOutcomeParams {
	waitResult: CursorBackendRunResult;
	prepared: CursorProviderTurnPrepareResult;
	signal?: AbortSignal;
	runResultFallback?: string;
	runErrorFallback?: RunError;
	resolvedApiKey?: string;
	optionsApiKey?: string;
}

export function buildCursorRunOutcomeFromWait(params: BuildCursorRunOutcomeParams): CursorRunOutcome {
	const { waitResult, prepared } = params;
	const { turnCoordinator, liveRun } = prepared.runtime;
	const { textDeltas } = prepared;
	return resolveCursorRunOutcome({
		waitResult,
		signalAborted: params.signal?.aborted,
		textDeltas: liveRun?.textDeltas ?? textDeltas,
		emittedText: liveRun?.emittedText ?? textDeltas.join(""),
		planTextCandidate: turnCoordinator.planTextCandidate,
		selectFinalTextOptions: liveRun ? undefined : { allowPartialPrefix: true },
		runResultFallback: params.runResultFallback,
		runErrorFallback: params.runErrorFallback,
		resolvedApiKey: params.resolvedApiKey,
		optionsApiKey: params.optionsApiKey,
		runtimeTarget: prepared.runtimeTarget,
	});
}

async function replayCursorTranscriptWebToolCalls(
	backendSession: LocalCursorBackendSession,
	messageOffset: number | undefined,
	turnCoordinator: CursorSdkTurnCoordinator,
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
): Promise<void> {
	try {
		const transcriptToolCalls = await backendSession.loadTranscriptWebToolCallsAfterOffset(messageOffset);
		if (transcriptToolCalls.length === 0) return;
		sdkEventDebug?.recordCoordinatorEvent("cursor-transcript-web-tools", {
			agentId: backendSession.id,
			messageOffset,
			count: transcriptToolCalls.length,
		});
		turnCoordinator.handleTranscriptCompletedToolCalls(transcriptToolCalls);
	} catch (error) {
		backendSession.invalidateMessageOffset();
		sdkEventDebug?.recordError("cursor_transcript_web_tools", error);
	}
}

function scrubCursorCloudReportingError(error: unknown, apiKey: string | undefined): Error {
	return new Error(scrubSensitiveText(error instanceof Error ? error.message : String(error), apiKey));
}

function recordCursorCloudReportingError(
	sdkEventDebug: CursorSdkEventDebugSink | undefined,
	error: unknown,
	apiKey: string | undefined,
): void {
	try {
		sdkEventDebug?.recordError("cloud_run_report", scrubCursorCloudReportingError(error, apiKey));
	} catch {
		// Debug reporting must never affect provider execution.
	}
}

export interface AwaitFinalizeCursorRunOutcomeParams {
	run: CursorBackendRun;
	prepared: CursorProviderTurnPrepareResult;
	cursorAgentMessageOffset: number | undefined;
	modelId: string;
	signal?: AbortSignal;
	runResultFallback?: string;
	runErrorFallback?: RunError;
	resolvedApiKey?: string;
	optionsApiKey?: string;
	sdkEventDebug?: CursorSdkEventDebugSink;
	waitResult?: CursorBackendRunResult;
	cacheContextWindow?: boolean;
}

export interface FinalizedCursorRunOutcome {
	outcome: CursorRunOutcome;
	displayOnlyTraceBlock?: string;
}

/** Single wait/finalize path for SDK runs: wait, debug capture, transcript replay, incomplete tools, artifacts, context cache. */
export async function awaitFinalizeCursorRunOutcome(params: AwaitFinalizeCursorRunOutcomeParams): Promise<FinalizedCursorRunOutcome> {
	const apiKey = params.resolvedApiKey ?? params.optionsApiKey;
	let waitResult: BuildCursorRunOutcomeParams["waitResult"];
	try {
		waitResult = params.waitResult ?? (await params.run.wait());
	} catch (error) {
		if (params.prepared.runtimeTarget === "local") {
			params.prepared.backendSession.invalidateMessageOffset();
		}
		throw error;
	}
	const outcome = buildCursorRunOutcomeFromWait({
		waitResult,
		prepared: params.prepared,
		signal: params.signal,
		runResultFallback: params.runResultFallback,
		runErrorFallback: params.runErrorFallback,
		resolvedApiKey: params.resolvedApiKey,
		optionsApiKey: params.optionsApiKey,
	});
	if (params.prepared.runtimeTarget === "local" && !isCursorRunFinishedSuccessfully(outcome)) {
		params.prepared.backendSession.invalidateMessageOffset();
	}
	const billed = await params.prepared.backendSession.attachBilledTurnUsage(params.run.id);
	params.prepared.runtime.billedTurnUsage = billed.turn;
	if (params.prepared.runtime.liveRun) {
		params.prepared.runtime.liveRun.billedTurnUsage = billed.turn;
	}
	let displayOnlyTraceBlock: string | undefined;
	if (params.prepared.runtimeTarget === "cloud" && isCursorRunFinishedSuccessfully(outcome)) {
		let report: CursorCloudRunReport = { agentId: params.run.agentId, runId: params.run.id, branches: [] };
		try {
			report = await params.prepared.backendSession.collectRunReport(
				params.run,
				waitResult,
				apiKey,
				billed.agentUsage,
			);
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
		try {
			recordCursorCloudLifecycleRun(report, { apiKey });
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
		try {
			params.sdkEventDebug?.recordProviderEvent("cloud_run_report", report);
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
		try {
			displayOnlyTraceBlock = formatCursorCloudRunReport(report, { apiKey });
		} catch (error) {
			recordCursorCloudReportingError(params.sdkEventDebug, error, apiKey);
		}
	}
	try {
		params.sdkEventDebug?.recordWaitResult(waitResult);
	} catch {
		// Debug reporting must never affect provider execution.
	}
	if (params.prepared.runtimeTarget === "local" && isCursorRunFinishedSuccessfully(outcome)) {
		await replayCursorTranscriptWebToolCalls(
			params.prepared.backendSession,
			params.cursorAgentMessageOffset,
			params.prepared.runtime.turnCoordinator,
			params.sdkEventDebug,
		);
	}
	params.prepared.runtime.turnCoordinator.discardIncompleteStartedToolCalls(outcome.incompleteTools);
	try {
		await params.sdkEventDebug?.captureRunArtifacts(params.run);
	} catch {
		// Debug artifact failures must never affect provider execution.
	}
	if (params.prepared.runtimeTarget === "local" && params.cacheContextWindow !== false) {
		await params.prepared.backendSession.cacheContextWindow(
			getCursorContextWindowCacheKey(params.modelId, params.prepared.meta.modelSelection),
		);
	}
	return { outcome, displayOnlyTraceBlock };
}

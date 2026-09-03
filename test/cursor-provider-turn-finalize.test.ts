import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "@cursor/sdk";
import type { CursorBackendRun, CursorBackendRunResult } from "../src/cursor-backend.js";
import type { CursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";
import type { CursorSdkEventDebugSink } from "../src/cursor-sdk-event-debug.js";
import { collectCursorCloudRunReport } from "../src/cursor-cloud-reporting.js";
import {
	CLOUD_LIFECYCLE_ENTRY_TYPE,
	__testUtils as cloudLifecycleTestUtils,
	recordCursorCloudLifecycleRun,
	registerCursorCloudLifecycleLedger,
} from "../src/cursor-cloud-lifecycle.js";
import { createPiHarness } from "./helpers/pi-harness.js";

const CLOUD_AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";


import { awaitFinalizeCursorRunOutcome } from "../src/cursor-provider-turn-finalize.js";

function makeCloudPrepared(agent: SDKAgent): CursorProviderTurnPrepareResult {
	return {
		runtimeTarget: "cloud",
		backendSession: {
			id: agent.agentId,
			send: async () => { throw new Error("unused"); },
			attachBilledTurnUsage: async () => ({}),
			collectRunReport: (
				run: CursorBackendRun,
				waitResult: CursorBackendRunResult,
				apiKey: string | undefined,
				agentUsage?: unknown,
			) => collectCursorCloudRunReport({
				access: {
					listArtifacts: agent.listArtifacts?.bind(agent),
					getUsage: agent.getUsage?.bind(agent),
				},
				run,
				waitResult,
				apiKey,
				agentUsage,
			}),
			dispose: async () => {},
		},
		cwd: process.cwd(),
		payload: { text: "hello" },
		meta: {},
		textDeltas: [],
		restoreCursorSdkOutputFilter: () => {},
		runtime: {
			kind: "direct",
			turnCoordinator: {
				planTextCandidate: undefined,
				discardIncompleteStartedToolCalls: vi.fn(),
			},
		},
	} as unknown as CursorProviderTurnPrepareResult;
}

describe("awaitFinalizeCursorRunOutcome", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		cloudLifecycleTestUtils.reset();
		cloudLifecycleTestUtils.setDurableWriter(() => true);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("records successful telemetry enrichment before isolated debug formatting work", async () => {
		const apiKey = "secret-cursor-key";
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		const listArtifacts = vi.fn().mockResolvedValue([
			{ path: "artifacts/report.txt", sizeBytes: { bad: true }, updatedAt: "now" },
			{ path: "valid.txt", sizeBytes: 1, updatedAt: "now" },
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const sdkEventDebug = {
			recordWaitResult: vi.fn(() => { throw new Error(`Bearer ${apiKey}`); }),
			captureRunArtifacts: vi.fn().mockRejectedValue(new Error(`Bearer ${apiKey}`)),
			recordProviderEvent: vi.fn(() => { throw new Error(`Bearer ${apiKey}`); }),
			recordError: vi.fn(),
		} as unknown as CursorSdkEventDebugSink;

		try {
			const finalized = await awaitFinalizeCursorRunOutcome({
				run: {
					id: "run-1",
					agentId: CLOUD_AGENT_ID,
					wait: vi.fn(),
				} as unknown as Awaited<ReturnType<SDKAgent["send"]>>,
				prepared: makeCloudPrepared({ agentId: CLOUD_AGENT_ID, listArtifacts } as unknown as SDKAgent),
				cursorAgentMessageOffset: undefined,
				modelId: "composer-2.5",
				waitResult: { id: "run-1", status: "finished", result: "cloud done" },
				resolvedApiKey: apiKey,
				sdkEventDebug,
			});

			expect(finalized.outcome.kind).toBe("finished");
			expect(finalized.displayOnlyTraceBlock).toContain("valid.txt (1 byte");
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
				agentId: CLOUD_AGENT_ID,
				runId: "run-1",
			}));
			expect(pi.appendEntry.mock.invocationCallOrder[0]).toBeGreaterThan(listArtifacts.mock.invocationCallOrder[0] ?? 0);
			expect(pi.appendEntry.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sdkEventDebug.recordProviderEvent).mock.invocationCallOrder[0] ?? Infinity);
			expect(pi.appendEntry.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sdkEventDebug.recordWaitResult).mock.invocationCallOrder[0] ?? Infinity);
			expect(sdkEventDebug.recordError).toHaveBeenCalledTimes(1);
			const [, error] = vi.mocked(sdkEventDebug.recordError).mock.calls[0];
			expect((error as Error).message).toContain("Bearer [redacted]");
			expect((error as Error).message).not.toContain(apiKey);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it.each(["error", "cancelled"] as const)("retains the send-phase cloud record and skips telemetry for %s outcomes", async (status) => {
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		const listArtifacts = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const sdkEventDebug = { recordProviderEvent: vi.fn() } as unknown as CursorSdkEventDebugSink;
		recordCursorCloudLifecycleRun({ agentId: CLOUD_AGENT_ID, runId: "run-failed", branches: [] });
		const wait = vi.fn(async () => {
			expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
				agentId: CLOUD_AGENT_ID,
				runId: "run-failed",
			}));
			return { id: "run-failed", status };
		});

		const finalized = await awaitFinalizeCursorRunOutcome({
			run: { id: "run-failed", agentId: CLOUD_AGENT_ID, wait } as unknown as Awaited<ReturnType<SDKAgent["send"]>>,
			prepared: makeCloudPrepared({ agentId: CLOUD_AGENT_ID, listArtifacts } as unknown as SDKAgent),
			cursorAgentMessageOffset: undefined,
			modelId: "composer-2.5",
			sdkEventDebug,
		});

		expect(finalized.outcome.kind).toBe(status === "error" ? "error" : "cancelled");
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(listArtifacts).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sdkEventDebug.recordProviderEvent).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("retains the send-phase lifecycle record when cloud wait throws", async () => {
		const pi = createPiHarness();
		registerCursorCloudLifecycleLedger(pi);
		const listArtifacts = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const sdkEventDebug = { recordProviderEvent: vi.fn() } as unknown as CursorSdkEventDebugSink;
		recordCursorCloudLifecycleRun({ agentId: CLOUD_AGENT_ID, runId: "run-throw", branches: [] });
		const wait = vi.fn(async () => {
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			throw new Error("wait failed");
		});

		await expect(awaitFinalizeCursorRunOutcome({
			run: { id: "run-throw", agentId: CLOUD_AGENT_ID, wait } as unknown as Awaited<ReturnType<SDKAgent["send"]>>,
			prepared: makeCloudPrepared({ agentId: CLOUD_AGENT_ID, listArtifacts } as unknown as SDKAgent),
			cursorAgentMessageOffset: undefined,
			modelId: "composer-2.5",
			sdkEventDebug,
		})).rejects.toThrow("wait failed");

		expect(pi.appendEntry).toHaveBeenCalledWith(CLOUD_LIFECYCLE_ENTRY_TYPE, expect.objectContaining({
			agentId: CLOUD_AGENT_ID,
			runId: "run-throw",
		}));
		expect(listArtifacts).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sdkEventDebug.recordProviderEvent).not.toHaveBeenCalled();
	});

	it("keeps successful telemetry enrichment best-effort after the send-phase record", async () => {
		const pi = createPiHarness();
		pi.appendEntry.mockImplementationOnce(() => { throw new Error("enriched ledger unavailable"); });
		registerCursorCloudLifecycleLedger(pi);

		const finalized = await awaitFinalizeCursorRunOutcome({
			run: { id: "run-1", agentId: CLOUD_AGENT_ID, wait: vi.fn() } as unknown as Awaited<ReturnType<SDKAgent["send"]>>,
			prepared: makeCloudPrepared({ agentId: CLOUD_AGENT_ID } as unknown as SDKAgent),
			cursorAgentMessageOffset: undefined,
			modelId: "composer-2.5",
			waitResult: { id: "run-1", status: "finished", result: "done" },
		});

		expect(finalized.outcome.kind).toBe("finished");
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});
});

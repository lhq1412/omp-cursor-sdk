import { Type } from "@oh-my-pi/omptype/typebox"
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	asMockSdkAgent,
	collectEvents,
	collectThinkingDeltas,
	createTestToolInfo,
	getDoneEvent,
	makeAssistantMessage,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedMessagesList,
	mockedResume,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorSessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";

describe("streamCursor local resume", () => {
	beforeEach(resetCursorProviderTestState);

	function seedResumeHandle(
		scopeKey: string,
		contextFingerprint = "{}",
		agentId = "agent-old",
		incrementalSendCount = 0,
		agentMessageOffset?: number,
	): void {
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey);
		const modelSelection = buildCursorModelSelection("gpt-5.5", "off", {
			fastEnabled: false,
			extendedContextEnabled: false,
		});
		const poolKey = cursorSessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, {
			apiKey: "test-key",
			agentMode: "agent",
			cwd: process.cwd(),
			modelSelection,
			localSafety: { autoReview: false, sandboxEnabled: false },
			localResume: true,
		});
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: agentMessageOffset === undefined ? 1 : 3,
				runtime: "local",
				agentId,
				scopeKey,
				sessionFile: scopeKey,
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint, incrementalSendCount },
				createdAt: "2026-07-07T00:00:00.000Z",
				...(agentMessageOffset === undefined ? {} : { agentMessageOffset }),
			},
		});
	}

	it("restores a v3 watermark and lists messages only after send", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
		const priorContext = makeContext();
		const resumedContext = makeContext([
			...priorContext.messages,
			makeAssistantMessage("Prior answer"),
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		mockedMessagesList.mockImplementation(async (_agentId, options) => {
			const offset = options?.offset ?? 0;
			return offset === 42
				? [{ type: "assistant", uuid: "agent-old:42", agent_id: "agent-old", message: {} }]
				: [];
		});
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) => {
			expect(mockedMessagesList).not.toHaveBeenCalled();
			return asMockCursorRun({
				id: "run-watermark",
				agentId: "agent-old",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-watermark", status: "finished", result: message.text ?? "" }),
			});
		});
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: mockSend }));
		seedResumeHandle(
			"/tmp/resume-watermark-session.jsonl",
			computeCursorContextFingerprint(priorContext),
			"agent-old",
			0,
			42,
		);

		await collectEvents(streamCursor(makeModel("gpt-5.5"), resumedContext, { apiKey: "test-key" }));

		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockedMessagesList.mock.calls.every(([, options]) => (options?.offset ?? 0) >= 42)).toBe(true);
		expect(resumeTestUtils.state.pendingHandle?.agentMessageOffset).toBe(43);
	});

	it("resumes with current bridge MCP and sends only the current OMP delta", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		registerBridgeForProviderTest({
			active: ["mcp", "subagent"],
			tools: [
				createTestToolInfo("mcp", Type.Object({}), "Call an MCP server"),
				createTestToolInfo("subagent", Type.Object({}), "Delegate to a pi subagent"),
			],
		});
		const priorContext = makeContext();
		const resumedContext = makeContext([
			...priorContext.messages,
			makeAssistantMessage("Prior answer"),
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) =>
			asMockCursorRun({
				id: "run-resumed",
				agentId: "agent-old",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-resumed", status: "finished", result: message.text ?? "" }),
			}),
		);
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: mockSend }));
		seedResumeHandle("/tmp/resume-bridge-session.jsonl", computeCursorContextFingerprint(priorContext));

		await collectEvents(streamCursor(makeModel("gpt-5.5"), resumedContext, { apiKey: "test-key" }));

		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedResume.mock.calls[0]?.[0]).toBe("agent-old");
		expect(mockedResume.mock.calls[0]?.[1]).toMatchObject({
			mcpServers: { pi_tools: { type: "http" } },
		});
		const prompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		expect(prompt.text).toContain("User: Follow up");
		expect(prompt.text).not.toContain("User: Hello");
		expect(prompt.text).not.toContain("Assistant: Prior answer");
		expect(prompt.text).not.toContain("Cursor SDK tool boundary:");
		expect(prompt.text).toContain("prefer pi__mcp for MCP work and pi__subagent for delegation");
	});

	it("starts a resumed billed-history baseline without delaying send and charges only the new usage UUID", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const context = makeContext();
		const historicalA = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 };
		const historicalB = { inputTokens: 20, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 2 };
		const currentC = { inputTokens: 30, outputTokens: 4, cacheReadTokens: 12, cacheWriteTokens: 3 };
		const baseline = Promise.withResolvers<{
			usage: typeof historicalA;
			runs: Array<{ runId: string; usage: typeof historicalA }>;
		}>();
		const getUsage = vi.fn()
			.mockReturnValueOnce(baseline.promise)
			.mockResolvedValueOnce({
				usage: { inputTokens: 60, outputTokens: 9, cacheReadTokens: 24, cacheWriteTokens: 6 },
				runs: [
					{ runId: "usage-a", usage: historicalA },
					{ runId: "usage-b", usage: historicalB },
					{ runId: "usage-c", usage: currentC },
				],
			});
		const mockSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-resumed-billed",
			agentId: "run-reported-agent",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-resumed-billed", status: "finished", result: "done" }),
		}));
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", getUsage, send: mockSend }));
		seedResumeHandle("/tmp/resume-billed-session.jsonl", computeCursorContextFingerprint(context));

		const eventsPromise = collectEvents(streamCursor(makeModel("gpt-5.5"), context, { apiKey: "test-key" }));
		try {
			await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
			expect(getUsage).toHaveBeenCalledTimes(1);
		} finally {
			baseline.resolve({
				usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 3 },
				runs: [
					{ runId: "usage-a", usage: historicalA },
					{ runId: "usage-b", usage: historicalB },
				],
			});
		}
		const events = await eventsPromise;

		expect(getUsage).toHaveBeenCalledTimes(2);
		expect(getDoneEvent(events).message.usage).toMatchObject({
			input: 15,
			output: 4,
			cacheRead: 12,
			cacheWrite: 3,
		});
	});

	it("retries a failed baseline without delaying the next send and bills only that next turn", async () => {
		const firstUsage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 };
		const secondUsage = { inputTokens: 20, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 2 };
		const retryBaseline = Promise.withResolvers<{
			usage: typeof firstUsage;
			runs: Array<{ runId: string; usage: typeof firstUsage }>;
		}>();
		const getUsage = vi.fn()
			.mockRejectedValueOnce(new Error("usage unavailable"))
			.mockReturnValueOnce(retryBaseline.promise)
			.mockResolvedValueOnce({
				usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 3 },
				runs: [
					{ runId: "usage-first", usage: firstUsage },
					{ runId: "usage-second", usage: secondUsage },
				],
			});
		const mockSend = vi.fn()
			.mockResolvedValueOnce(asMockCursorRun({
				id: "run-first",
				agentId: "run-reported-agent",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-first", status: "finished", result: "first" }),
			}))
			.mockResolvedValueOnce(asMockCursorRun({
				id: "run-second",
				agentId: "run-reported-agent",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-second", status: "finished", result: "second" }),
			}));
		mockCreatedAgent({ agentId: "agent-retry", getUsage, send: mockSend });
		const firstContext = makeContext();
		await collectEvents(streamCursor(makeModel("gpt-5.5"), firstContext, { apiKey: "test-key" }));
		expect(getUsage).toHaveBeenCalledTimes(1);

		const secondContext = makeContext([
			...firstContext.messages,
			makeAssistantMessage("first"),
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		const secondEventsPromise = collectEvents(streamCursor(makeModel("gpt-5.5"), secondContext, { apiKey: "test-key" }));
		try {
			await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
			expect(getUsage).toHaveBeenCalledTimes(2);
		} finally {
			retryBaseline.resolve({ usage: firstUsage, runs: [{ runId: "usage-first", usage: firstUsage }] });
		}
		const secondEvents = await secondEventsPromise;

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(getUsage).toHaveBeenCalledTimes(3);
		expect(getDoneEvent(secondEvents).message.usage).toMatchObject({
			input: 10,
			output: 3,
			cacheRead: 8,
			cacheWrite: 2,
		});
	});

	it.each([
		{ reason: "incremental_threshold", fingerprint: (context: ReturnType<typeof makeContext>) => computeCursorContextFingerprint(context), count: 20 },
		{ reason: "context_divergence", fingerprint: () => "stale-context", count: 0 },
	])("replaces a resumed agent with Agent.create for $reason while preserving resume persistence", async ({ fingerprint, count }) => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const context = makeContext();
		const oldDispose = vi.fn().mockResolvedValue(undefined);
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({
			agentId: "agent-old",
			send: vi.fn(),
			[Symbol.asyncDispose]: oldDispose,
		}));
		const newSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-new",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-new", status: "finished", result: "done" }),
		}));
		mockCreatedAgent({ agentId: "agent-new", send: newSend });
		seedResumeHandle(`/tmp/reset-${count}.jsonl`, fingerprint(context), "agent-old", count);

		await collectEvents(streamCursor(makeModel("gpt-5.5"), context, { apiKey: "test-key" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(oldDispose).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(newSend).toHaveBeenCalledTimes(1);
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({ agentId: "agent-new" });
	});

	it("does not pass a crafted cloud agent ID to local Agent.resume", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		mockCreatedAgent({
			agentId: "agent-new",
			send: vi.fn().mockResolvedValue(asMockCursorRun({
				id: "run-new",
				agentId: "agent-new",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-new", status: "finished", result: "done" }),
			})),
		});
		seedResumeHandle("/tmp/reject-cloud-resume-session.jsonl", "{}", "bc-cloud-agent");

		await collectEvents(streamCursor(makeModel("gpt-5.5"), makeContext(), { apiKey: "test-key" }));

		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(1);
	});

	it("falls back from local Agent.resume with a display-only continuity note", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedResume.mockRejectedValueOnce(new Error("Agent agent-old not found"));
		mockCreatedAgent({ agentId: "agent-new", send: mockSend });
		seedResumeHandle("/tmp/resume-session.jsonl");

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5"), makeContext(), { apiKey: "test-key" }));
		const followUpEvents = await collectEvents(streamCursor(makeModel("gpt-5.5"), makeContext(), { apiKey: "test-key" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(collectThinkingDeltas(events)).toContain("Could not resume prior Cursor agent");
		expect(JSON.stringify(getDoneEvent(events).message.content)).not.toContain("Could not resume prior Cursor agent");
		expect(collectThinkingDeltas(followUpEvents)).not.toContain("Could not resume prior Cursor agent");
	});

	it("emits the resume fallback continuity note on the live native replay path", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedResume.mockRejectedValueOnce(new Error("Agent agent-old not found"));
		mockCreatedAgent({ agentId: "agent-new", send: mockSend });
		seedResumeHandle("/tmp/resume-live-session.jsonl");

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5"), makeContext(), { apiKey: "test-key" }));

		expect(collectThinkingDeltas(events)).toContain("Could not resume prior Cursor agent");
		expect(JSON.stringify(getDoneEvent(events).message.content)).not.toContain("Could not resume prior Cursor agent");
	});
});

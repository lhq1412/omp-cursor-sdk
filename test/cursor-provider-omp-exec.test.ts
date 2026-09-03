import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { isCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	resetCursorProviderTestState,
	mockCreatedAgent,
	makeModel,
	makeContext,
	collectEvents,
	getCreatedAgentOptions,
	getDoneEvent,
	registerBridgeForProviderTest,
	createTestToolInfo,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import { drainCursorLiveRunTurn, cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import { CURSOR_OMP_EXEC_DISALLOWED_TOOLS } from "../src/cursor-omp-exec-adapter.js";

function finishedRun() {
	return {
		id: "run-1",
		agentId: "agent-1",
		status: "finished",
		wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "ok" }),
		cancel: vi.fn(),
		supports: () => true,
		unsupportedReason: () => undefined,
	};
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("cursor-sdk OMP exec adapter wiring", () => {
	beforeEach(resetCursorProviderTestState);

	it("does not restrict tools or attach customTools without execHandlers", async () => {
		const mockSend = vi.fn().mockResolvedValue(finishedRun());
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), { apiKey: "test-key" }));

		expect(getCreatedAgentOptions().disallowedTools).toBeUndefined();
		expect(mockSend.mock.calls[0]?.[1]?.local?.customTools).toBeUndefined();
	});

	it("disallows native builtins and routes customTools through execHandlers", async () => {
		const piRead = vi.fn(async () => toolResult("file"));
		const mockSend = vi.fn().mockResolvedValue(finishedRun());
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), {
			apiKey: "test-key",
			execHandlers: { piRead },
		}));

		expect(getCreatedAgentOptions().disallowedTools).toEqual([...CURSOR_OMP_EXEC_DISALLOWED_TOOLS]);
		const customTools = mockSend.mock.calls[0]?.[1]?.local?.customTools;
		expect(customTools?.read).toBeDefined();
		expect(await customTools.read.execute({ path: "a.ts" }, { toolCallId: "tc" })).toEqual({
			content: [{ type: "text", text: "file" }],
			isError: false,
		});
		expect(piRead).toHaveBeenCalledTimes(1);
	});

	it("keeps the extension MCP bridge when execHandlers are present", async () => {
		registerBridgeForProviderTest({
			active: ["sem_reindex"],
			tools: [createTestToolInfo("sem_reindex", Type.Object({ target: Type.String() }), "Reindex semantic cache")],
		});
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue(finishedRun()),
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), {
			apiKey: "test-key",
			execHandlers: { piRead: async () => toolResult("file") },
		}));

		expect(getCreatedAgentOptions().mcpServers?.pi_tools?.type).toBe("http");
		expect(getCreatedAgentOptions().disallowedTools).toEqual([...CURSOR_OMP_EXEC_DISALLOWED_TOOLS]);
	});

	it("stamps kCursorExecResolved toolCalls and reports cursorOnToolResult", async () => {
		const piRead = vi.fn(async () => toolResult("file"));
		const cursorOnToolResult = vi.fn(async (message: ToolResultMessage) => message);
		const mockSend = vi.fn().mockImplementation(async (_payload: unknown, sendOptions: unknown) => {
			// Agent.send options are SDK-typed; this mock only needs customTools.execute.
			const options = sendOptions as { local?: { customTools?: Record<string, { execute: (args: object, context: object) => Promise<unknown> }> } };
			await options.local?.customTools?.read?.execute({ path: "a.ts" }, { toolCallId: "tc" });
			return finishedRun();
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel("composer-2"), makeContext(), {
			apiKey: "test-key",
			execHandlers: { piRead },
			cursorOnToolResult,
		}));

		expect(cursorOnToolResult).toHaveBeenCalledTimes(1);
		expect(cursorOnToolResult.mock.calls[0]?.[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "tc",
			isError: false,
		});
		const toolEnds = events.filter((event) => event.type === "toolcall_end");
		expect(toolEnds).toHaveLength(1);
		expect(isCursorExecResolved(toolEnds[0]?.toolCall)).toBe(true);
		const done = getDoneEvent(events);
		const block = done.message.content.find((entry) => entry.type === "toolCall");
		expect(block).toMatchObject({ type: "toolCall", id: "tc" });
		expect(isCursorExecResolved(block)).toBe(true);
	});
	it("queues resolved exec behind live-run text instead of jumping the stream", () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const liveRun = { disposed: false, pendingEvents: [] as Array<{ type: string }> };
		const coordinator = new CursorSdkTurnCoordinator({
			stream,
			partial,
			cwd: process.cwd(),
			useNativeToolReplay: false,
			nativeReplayId: "nr",
			textDeltas: [],
			liveRun: liveRun as never,
			ompExecEnabled: true,
		});
		const onToolResult = vi.fn();
		coordinator.handleDelta({ type: "text-delta", text: "hello" } as never);
		coordinator.emitResolvedOmpExecTool(toolResult("file"), { path: "a.ts" }, onToolResult);
		expect(liveRun.pendingEvents.map((event) => event.type)).toEqual(["text-delta", "omp-exec-resolved"]);
		expect(partial.content.some((block) => block.type === "toolCall")).toBe(false);
		expect(onToolResult).not.toHaveBeenCalled();
	});

	it("flushes queued omp-exec-resolved before chain_user_input release", async () => {
		const stream = createAssistantMessageEventStream();
		const eventsPromise = collectEvents(stream);
		const partial = makeAssistantMessage("");
		const onToolResult = vi.fn();
		const run = cursorLiveRuns.start({
			id: "chain-exec",
			agentId: "a1",
			promptInputTokens: 0,
			sessionAgentScopeKey: "chain-exec-scope",
		});
		run.done = true;
		run.pendingEvents.push({
			type: "omp-exec-resolved",
			toolResult: toolResult("file"),
			args: { path: "a.ts" },
			onToolResult,
		});
		await drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, { mode: "chain_user_input" });
		stream.push({ type: "done", reason: "stop", message: partial });
		await eventsPromise;
		expect(onToolResult).toHaveBeenCalledTimes(1);
		const block = partial.content.find((entry) => entry.type === "toolCall");
		expect(block).toMatchObject({ type: "toolCall", id: "tc" });
		expect(isCursorExecResolved(block)).toBe(true);
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	resetCursorProviderTestState,
	mockCreatedAgent,
	makeModel,
	makeContext,
	collectEvents,
	getCreatedAgentOptions,
	registerBridgeForProviderTest,
	createTestToolInfo,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
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
});

import { Agent, type AgentMessage, type SDKAgent } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectCursorTranscriptWebToolCalls,
	getCursorAgentMessageOffset,
	initializeCursorAgentMessageOffset,
	invalidateCursorAgentMessageOffset,
	loadCursorTranscriptWebToolCallsAfterOffset,
	parseCursorAgentMessageOffsetWatermark,
} from "../src/cursor-agent-message-web-tools.js";

const fakeAgentMessage: AgentMessage = {
	type: "assistant",
	uuid: "agent-1:0",
	agent_id: "agent-1",
	message: {},
};

function fakeAgent(agentId = "agent-1"): SDKAgent {
	return { agentId } as SDKAgent;
}

function fakeWebSearchMessage(index: number): AgentMessage {
	return {
		type: "assistant",
		uuid: `agent-1:${index}`,
		agent_id: "agent-1",
		message: {
			turn: {
				case: "agentConversationTurn",
				value: {
					steps: [
						{
							message: {
								case: "toolCall",
								value: {
									tool: {
										case: "webSearchToolCall",
										value: {
											args: { searchTerm: `query-${index}`, toolCallId: `tool-${index}` },
											result: {
												result: {
													case: "success",
													value: { references: [{ title: "Result", url: "", chunk: `result-${index}` }] },
												},
											},
										},
									},
								},
							},
						},
					],
				},
			},
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cursor agent message offset watermark", () => {
	it("seeds a new agent at zero without listing messages", () => {
		const list = vi.spyOn(Agent.messages, "list");
		const agent = fakeAgent();

		initializeCursorAgentMessageOffset(agent, { resumed: false });

		expect(getCursorAgentMessageOffset(agent)).toBe(0);
		expect(list).not.toHaveBeenCalled();
	});

	it("restores a persisted resume watermark without listing messages", () => {
		const list = vi.spyOn(Agent.messages, "list");
		const agent = fakeAgent();

		initializeCursorAgentMessageOffset(agent, { resumed: true, persistedOffset: 42 });

		expect(getCursorAgentMessageOffset(agent)).toBe(42);
		expect(list).not.toHaveBeenCalled();
	});

	it("leaves legacy resumed handles on an unknown baseline until finalize recount", () => {
		const list = vi.spyOn(Agent.messages, "list");
		const agent = fakeAgent();

		initializeCursorAgentMessageOffset(agent, { resumed: true });

		expect(getCursorAgentMessageOffset(agent)).toBeUndefined();
		expect(list).not.toHaveBeenCalled();
	});

	it("paginates the completed turn, replays web tools, and advances the next-send watermark", async () => {
		const messages = Array.from({ length: 10 }, (_, index) => (
			index === 1 || index === 8
				? fakeWebSearchMessage(index)
				: { ...fakeAgentMessage, uuid: `agent-1:${index}` }
		));
		const list = vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) => {
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? messages.length;
			return messages.slice(offset, offset + limit);
		});
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { resumed: false });
		const offset = getCursorAgentMessageOffset(agent);

		const replay = await loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: "/repo", offset });

		expect(replay.toolCalls.map((call) => call.identity)).toEqual([
			"cursor-transcript:agent-1:1:webSearch:tool-1",
			"cursor-transcript:agent-1:8:webSearch:tool-8",
		]);
		expect(replay.nextOffset).toBe(10);
		expect(list.mock.calls.map(([, options]) => options?.offset)).toEqual([0, 8]);
		expect(getCursorAgentMessageOffset(agent)).toBe(10);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("rebases a known watermark when the transcript is shorter than the baseline", async () => {
		const messages = Array.from({ length: 8 }, (_, index) => ({ ...fakeAgentMessage, uuid: `agent-1:${index}` }));
		vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) => {
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? messages.length;
			return messages.slice(offset, offset + limit);
		});
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { resumed: true, persistedOffset: 10 });

		const replay = await loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: "/repo", offset: 10 });

		expect(replay).toEqual({ toolCalls: [], nextOffset: 8 });
		expect(getCursorAgentMessageOffset(agent)).toBe(8);
	});

	it("recounts once for unknown baseline without replaying transcript tools", async () => {
		const list = vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) =>
			(options?.offset ?? 0) < 2 ? [fakeAgentMessage] : []
		);
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { resumed: true });

		const replay = await loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: "/repo", offset: undefined });

		expect(replay).toEqual({ toolCalls: [], replaySkipped: "unknown-baseline", nextOffset: 2 });
		expect(getCursorAgentMessageOffset(agent)).toBe(2);
		expect(list.mock.calls.some(([, options]) => options?.limit === 8)).toBe(false);
	});

	it("marks invalidation as unknown without forcing a pre-send recount", () => {
		const list = vi.spyOn(Agent.messages, "list");
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { resumed: false });

		invalidateCursorAgentMessageOffset(agent);

		expect(getCursorAgentMessageOffset(agent)).toBeUndefined();
		expect(list).not.toHaveBeenCalled();
	});

	it("invalidates on transcript-list failure", async () => {
		const list = vi.spyOn(Agent.messages, "list").mockRejectedValueOnce(new Error("transcript unavailable"));
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { resumed: false });

		await expect(loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: "/repo", offset: 0 }))
			.rejects.toThrow("transcript unavailable");
		expect(getCursorAgentMessageOffset(agent)).toBeUndefined();
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("keeps watermarks separate for distinct SDKAgent handles with the same agent ID", () => {
		const created = fakeAgent("shared-agent-id");
		const resumed = fakeAgent("shared-agent-id");

		initializeCursorAgentMessageOffset(created, { resumed: false });
		initializeCursorAgentMessageOffset(resumed, { resumed: true, persistedOffset: 1 });

		expect(getCursorAgentMessageOffset(created)).toBe(0);
		expect(getCursorAgentMessageOffset(resumed)).toBe(1);
	});

	it("ignores malformed persisted watermark values", () => {
		expect(parseCursorAgentMessageOffsetWatermark(-1)).toBeUndefined();
		expect(parseCursorAgentMessageOffsetWatermark(1.5)).toBeUndefined();
		expect(parseCursorAgentMessageOffsetWatermark("3")).toBeUndefined();
	});
});

describe("collectCursorTranscriptWebToolCalls", () => {
	it("extracts protobuf-style Cursor WebSearch calls from local agent messages", () => {
		const calls = collectCursorTranscriptWebToolCalls([
			{
				type: "user",
				uuid: "agent-1:7",
				agent_id: "agent-1",
				message: {
					turn: {
						case: "agentConversationTurn",
						value: {
							steps: [
								{
									message: {
										case: "toolCall",
										value: {
											tool: {
												case: "webSearchToolCall",
												value: {
													args: { searchTerm: "Cursor IDE", toolCallId: "tool-1" },
													result: {
														result: {
															case: "success",
															value: {
																references: [
																	{
																		title: "Web search results",
																		url: "",
																		chunk: "Links:\n1. [Cursor — Build Software with AI Agents](https://cursor.com/product)",
																	},
																],
															},
														},
													},
												},
											},
										},
									},
								},
							],
						},
					},
				},
			},
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0].identity).toBe("cursor-transcript:agent-1:7:webSearch:tool-1");
		expect(calls[0].toolCall).toEqual({
			name: "webSearch",
			args: { searchTerm: "Cursor IDE", toolCallId: "tool-1" },
			result: {
				status: "success",
				value: {
					content: [
						{
							type: "text",
							text: "Links:\n1. [Cursor — Build Software with AI Agents](https://cursor.com/product)",
						},
					],
				},
			},
		});
	});

	it("extracts protobuf-style Cursor WebFetch calls from local agent messages", () => {
		const calls = collectCursorTranscriptWebToolCalls([
			{
				type: "assistant",
				uuid: "agent-1:8",
				agent_id: "agent-1",
				message: {
					turn: {
						case: "agentConversationTurn",
						value: {
							steps: [
								{
									message: {
										case: "toolCall",
										value: {
											tool: {
												case: "webFetchToolCall",
												value: {
													args: { url: "https://example.com", toolCallId: "tool-fetch-1" },
													result: {
														result: {
															case: "success",
															value: {
																content: [{ type: "text", text: "<title>Example Domain</title>" }],
															},
														},
													},
												},
											},
										},
									},
								},
							],
						},
					},
				},
			},
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0].identity).toBe("cursor-transcript:agent-1:8:webFetch:tool-fetch-1");
		expect(calls[0].toolCall).toEqual({
			name: "webFetch",
			args: { url: "https://example.com", toolCallId: "tool-fetch-1" },
			result: {
				status: "success",
				value: {
					content: [
						{
							type: "text",
							text: "<title>Example Domain</title>",
						},
					],
				},
			},
		});
	});
});

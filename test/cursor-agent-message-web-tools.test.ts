import { Agent, type AgentMessage, type SDKAgent } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectCursorTranscriptWebToolCalls,
	initializeCursorAgentMessageOffset,
	invalidateCursorAgentMessageOffset,
	loadCursorTranscriptWebToolCallsAfterOffset,
	readCursorAgentMessageOffset,
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
	it("seeds a new agent at zero without listing messages", async () => {
		const list = vi.spyOn(Agent.messages, "list");
		const agent = fakeAgent();

		initializeCursorAgentMessageOffset(agent, { cwd: "/repo", resumed: false });

		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(0);
		expect(list).not.toHaveBeenCalled();
	});

	it("starts one resumed-agent count beyond the old cap and reuses its result", async () => {
		const messageCount = 5000;
		const list = vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) =>
			(options?.offset ?? 0) < messageCount ? [fakeAgentMessage] : []
		);
		const agent = fakeAgent();

		initializeCursorAgentMessageOffset(agent, { cwd: "/repo", resumed: true });

		await expect(Promise.all([
			readCursorAgentMessageOffset(agent, "/repo"),
			readCursorAgentMessageOffset(agent, "/repo"),
		])).resolves.toEqual([messageCount, messageCount]);
		expect(list).toHaveBeenCalledWith("agent-1", { runtime: "local", cwd: "/repo", limit: 1, offset: 4096 });
		const callsAfterInitialization = list.mock.calls.length;
		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(messageCount);
		expect(list).toHaveBeenCalledTimes(callsAfterInitialization);
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
		initializeCursorAgentMessageOffset(agent, { cwd: "/repo", resumed: false });
		const offset = await readCursorAgentMessageOffset(agent, "/repo");

		const calls = await loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: "/repo", offset });

		expect(calls.map((call) => call.identity)).toEqual([
			"cursor-transcript:agent-1:1:webSearch:tool-1",
			"cursor-transcript:agent-1:8:webSearch:tool-8",
		]);
		expect(list.mock.calls.map(([, options]) => options?.offset)).toEqual([0, 8]);
		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(10);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("recounts once after failed-outcome invalidation", async () => {
		const list = vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) =>
			(options?.offset ?? 0) < 2 ? [fakeAgentMessage] : []
		);
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { cwd: "/repo", resumed: false });

		invalidateCursorAgentMessageOffset(agent);
		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(2);
		const callsAfterRecovery = list.mock.calls.length;
		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(2);
		expect(list).toHaveBeenCalledTimes(callsAfterRecovery);
	});

	it("invalidates on transcript-list failure and recounts once on the next read", async () => {
		const list = vi.spyOn(Agent.messages, "list").mockRejectedValueOnce(new Error("transcript unavailable"));
		const agent = fakeAgent();
		initializeCursorAgentMessageOffset(agent, { cwd: "/repo", resumed: false });

		await expect(loadCursorTranscriptWebToolCallsAfterOffset({ agent, cwd: "/repo", offset: 0 }))
			.rejects.toThrow("transcript unavailable");
		list.mockResolvedValue([]);
		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(0);
		const callsAfterRecovery = list.mock.calls.length;
		await expect(readCursorAgentMessageOffset(agent, "/repo")).resolves.toBe(0);
		expect(list).toHaveBeenCalledTimes(callsAfterRecovery);
	});

	it("keeps watermarks separate for distinct SDKAgent handles with the same agent ID", async () => {
		vi.spyOn(Agent.messages, "list").mockImplementation(async (_agentId, options) =>
			(options?.offset ?? 0) < 1 ? [fakeAgentMessage] : []
		);
		const created = fakeAgent("shared-agent-id");
		const resumed = fakeAgent("shared-agent-id");

		initializeCursorAgentMessageOffset(created, { cwd: "/repo", resumed: false });
		initializeCursorAgentMessageOffset(resumed, { cwd: "/repo", resumed: true });

		await expect(readCursorAgentMessageOffset(created, "/repo")).resolves.toBe(0);
		await expect(readCursorAgentMessageOffset(resumed, "/repo")).resolves.toBe(1);
		await expect(readCursorAgentMessageOffset(created, "/repo")).resolves.toBe(0);
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

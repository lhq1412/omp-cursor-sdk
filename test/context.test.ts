import { describe, it, expect } from "vitest";
import { Type } from "@oh-my-pi/omptype/typebox";
import { buildCursorHistoryForTest } from "@oh-my-pi/pi-ai/providers/cursor";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent";
import {
	buildCursorPrompt,
	buildCursorIncrementalPrompt,
	computeCursorContextFingerprint,
	shouldBootstrapCursorContext,
	CURSOR_IMAGE_TOKEN_ESTIMATE,
	estimateCursorContextTokens,
	estimateCursorPromptMessageTokens,
	getCursorToolTailGuardText,
} from "../src/context.js";
import {
	buildCursorSessionSendPrompt,
	planCursorSessionSend,
} from "../src/cursor-session-send-policy.js";
import type { Context, UserMessage, AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";

function makeAssistant(
	content: AssistantMessage["content"],
	timestamp: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-sdk",
		provider: "cursor-sdk",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function buildBuiltInSemanticReference(context: Context) {
	const messages = convertToLlm(context.messages as Parameters<typeof convertToLlm>[0]);
	const finalMessage = messages.at(-1);
	const activeMessageIndex =
		finalMessage?.role === "user" || finalMessage?.role === "developer" ? messages.length - 1 : -1;
	return buildCursorHistoryForTest(messages, activeMessageIndex);
}

describe("buildCursorPrompt", () => {
	it("includes system prompt", () => {
		const ctx: Context = {
			systemPrompt: ["You are helpful."],
			messages: [],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("System instructions from OMP:");
		expect(result.text).toContain("You are helpful.");
	});

	it("omits OMP host tool policy while preserving skills and workflow instructions", () => {
		const ctx: Context = {
			systemPrompt: [[
				"<system-conventions>",
				"System convention stays.",
				"</system-conventions>",
				"",
				"§ Role",
				"Helpful OMP role stays.",
				"",
				"§ Runtime",
				"# Skills & Rules",
				"<skills>",
				"- private-skill: private local skill",
				"</skills>",
				"",
				"# Internal URLs",
				"- skill://<name>: instructions",
				"",
				"# Tool Inventory",
				"- `custom_private_tool`",
				"",
				"§ Tool Policy",
				"- Use custom_private_tool for private work.",
				"",
				"§ Workflow",
				"# 1. Scope",
				"- Project instruction stays.",
				"",
				"§ Delivery",
				"<contract>",
				"Current date: 2026-05-20",
				"</contract>",
			].join("\n")],
			messages: [],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("OMP host tool catalog and tool policy omitted");
		expect(result.text).toContain("System convention stays.");
		expect(result.text).toContain("private-skill");
		expect(result.text).toContain("§ Workflow");
		expect(result.text).toContain("Project instruction stays.");
		expect(result.text).toContain("Current date: 2026-05-20");
		expect(result.text).not.toContain("custom_private_tool");
		expect(result.text).not.toContain("# Internal URLs");
		expect(result.text).not.toContain("§ Tool Policy");
	});

	it("tracks the installed OMP host tool-policy boundaries", async () => {
		const relativePath = ["..", "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "system-prompt.ts"].join("/");
		const installedOmp = await import(new URL(relativePath, import.meta.url).href) as {
			buildSystemPrompt(options?: Record<string, unknown>): Promise<{ systemPrompt: string[] }>;
		};
		const cwd = process.env.PI_CODING_AGENT_DIR ?? process.cwd();
		const built = await installedOmp.buildSystemPrompt({
			cwd,
			contextFiles: [],
			skills: [],
			activeRepoContext: null,
			workspaceTree: {
				rootPath: cwd,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			personality: "none",
			toolNames: ["custom_private_tool"],
			rules: [],
			alwaysApplyRules: [],
			includeWorkspaceTree: false,
			includeModelInPrompt: false,
		});
		const source = built.systemPrompt.join("\n");
		expect(source).toContain("# Internal URLs");
		expect(source).toContain("§ Tool Policy");
		expect(source).toContain("§ Workflow");
		expect(source).toContain("custom_private_tool");

		const result = buildCursorPrompt({ systemPrompt: built.systemPrompt, messages: [] });
		expect(result.text).toContain("OMP host tool catalog and tool policy omitted");
		expect(result.text).toContain("§ Workflow");
		expect(result.text).not.toContain("# Internal URLs");
		expect(result.text).not.toContain("§ Tool Policy");
		expect(result.text).not.toContain("custom_private_tool");
	});

	it("does not rewrite custom prompts that reuse OMP section headings", () => {
		const customPrompt = [
			"Custom operator instructions.",
			"# Internal URLs",
			"Keep this custom section.",
			"§ Workflow",
			"Keep this custom workflow.",
		].join("\n");
		const result = buildCursorPrompt({ systemPrompt: [customPrompt], messages: [] });

		expect(result.text).toContain(customPrompt);
		expect(result.text).not.toContain("OMP host tool catalog and tool policy omitted");
	});

	it("formats user and assistant messages", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 } satisfies UserMessage,
				{ role: "assistant", content: [{ type: "text", text: "Hi there" }], api: "cursor-sdk", provider: "cursor-sdk", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } satisfies AssistantMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("User: Hello");
		expect(result.text).toContain("Assistant: Hi there");
	});

	it("defensively formats assistant string content", () => {
		const ctx: Context = {
			messages: [
				{
					role: "assistant",
					content: "String assistant text",
					api: "cursor-sdk",
					provider: "cursor-sdk",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				} as unknown as Context["messages"][number],
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Assistant: String assistant text");
	});

	it("omits thinking content from transcript", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Think hard", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal thought" },
						{ type: "text", text: "Final answer" },
					],
					api: "cursor-sdk", provider: "cursor-sdk", model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: 2,
				} satisfies AssistantMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Final answer");
		expect(result.text).not.toContain("internal thought");
	});

	it("renders orphan tool results as assistant-visible fallback text", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Run it", timestamp: 1 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "output here" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Assistant: [Tool Result]\noutput here");
		expect(result.text).not.toContain("Tool result (bash, call tc1)");
	});

	it("renders orphan tool errors as assistant-visible fallback text", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Run it", timestamp: 1 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "command failed" }],
					isError: true,
					timestamp: 2,
				} satisfies ToolResultMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Assistant: [Tool Error]\ncommand failed");
		expect(result.text).not.toContain("Tool error (bash, call tc1)");
	});

	it("preserves real OMP edit and write tool names in Cursor prompt labels", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "Edit and write files", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "edit-call", name: "edit", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", id: "write-call", name: "write", arguments: { path: "src/b.ts" } },
					],
					api: "cursor-sdk",
					provider: "cursor-sdk",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 2,
				} satisfies AssistantMessage,
				{
					role: "toolResult",
					toolCallId: "edit-call",
					toolName: "edit",
					content: [{ type: "text", text: "edit ok" }],
					isError: false,
					timestamp: 3,
				} satisfies ToolResultMessage,
				{
					role: "toolResult",
					toolCallId: "write-call",
					toolName: "write",
					content: [{ type: "text", text: "write ok" }],
					isError: false,
					timestamp: 4,
				} satisfies ToolResultMessage,
			],
		};

		const result = buildCursorPrompt(ctx);

		expect(result.text).toContain('Tool call (edit, call edit-call): {"path":"src/a.ts"}');
		expect(result.text).toContain('Tool call (write, call write-call): {"path":"src/b.ts"}');
		expect(result.text).toContain("Tool result (edit, call edit-call): edit ok");
		expect(result.text).toContain("Tool result (write, call write-call): write ok");
		expect(result.text).not.toContain("Tool call (Cursor edit");
		expect(result.text).not.toContain("Tool call (Cursor write");
		expect(result.text).not.toContain("Tool result (Cursor edit");
		expect(result.text).not.toContain("Tool result (Cursor write");
	});

	it("labels canonical neutral Cursor replay activity without rewriting literal transcript text", () => {
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: "Please search for the literal string replay_marker.",
					timestamp: 0,
				} satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will preserve literal activity_marker text." },
						{ type: "toolCall", id: "activity-call", name: "cursor", arguments: { activityTitle: "Cursor MCP", note: "result_marker" } },
						{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "echo mcp_marker" } },
					],
					api: "cursor-sdk",
					provider: "cursor-sdk",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 1,
				} satisfies AssistantMessage,
				{
					role: "toolResult",
					toolCallId: "activity-call",
					toolName: "cursor",
					content: [{ type: "text", text: "recorded replay_marker result" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage,
			],
		};

		const result = buildCursorPrompt(ctx);

		expect(result.text).toContain("User: Please search for the literal string replay_marker.");
		expect(result.text).toContain("Assistant: I will preserve literal activity_marker text.");
		expect(result.text).toContain("Tool call (Cursor activity, call activity-call)");
		expect(result.text).toContain('{"activityTitle":"Cursor MCP","note":"result_marker"}');
		expect(result.text).toContain('Tool call (bash, call bash-call): {"command":"echo mcp_marker"}');
		expect(result.text).toContain("Tool result (Cursor activity, call activity-call): recorded replay_marker result");
	});

	it("estimates assistant prompt-message tokens from replayed text and tool calls but not thinking", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden reasoning" },
				{ type: "text", text: "I will inspect the directory." },
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
			],
			api: "cursor-sdk",
			provider: "cursor-sdk",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		} satisfies AssistantMessage;

		const expected = 'Assistant: I will inspect the directory.\nTool call (bash, call tc1): {"command":"ls"}';
		expect(estimateCursorPromptMessageTokens(assistant, { charsPerToken: 1 })).toBe(expected.length);
		expect(expected).not.toContain("hidden reasoning");
	});

	it("estimates tool-result prompt-message tokens from replayed tool result text", () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text", text: "README.md" }],
			isError: false,
			timestamp: 3,
		} satisfies ToolResultMessage;

		expect(estimateCursorPromptMessageTokens(toolResult, { charsPerToken: 1 })).toBe("Assistant: [Tool Result]\nREADME.md".length);
	});

	it("estimates tool-result image prompt content as the replay placeholder text", () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read_image",
			content: [{ type: "image", data: "base64", mimeType: "image/png" }],
			isError: false,
			timestamp: 3,
		} satisfies ToolResultMessage;

		expect(estimateCursorPromptMessageTokens(toolResult, { charsPerToken: 1 })).toBe(
			"Assistant: [Tool Result]\n[image/png image]".length,
		);
	});

	it("estimates context tokens from the budgeted Cursor prompt and latest user image reserve", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: `old ${"x".repeat(200)}`, timestamp: 1 } satisfies UserMessage,
				{
					role: "user",
					content: [
						{ type: "text", text: "latest request" },
						{ type: "image", data: "newbase64", mimeType: "image/png" },
					],
					timestamp: 2,
				} satisfies UserMessage,
			],
		};
		const options = { maxInputTokens: 80, charsPerToken: 1, imageTokenEstimate: CURSOR_IMAGE_TOKEN_ESTIMATE };
		const prompt = buildCursorPrompt(ctx, options);

		expect(prompt.text).not.toContain("old ");
		expect(prompt.images).toHaveLength(1);
		expect(estimateCursorContextTokens(ctx, options)).toBe(prompt.text.length + CURSOR_IMAGE_TOKEN_ESTIMATE);
	});

	it("formats assistant tool calls before tool results", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "List files", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the directory." },
						{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
					],
					api: "cursor-sdk",
					provider: "cursor-sdk",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 2,
				} satisfies AssistantMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "README.md" }],
					isError: false,
					timestamp: 3,
				} satisfies ToolResultMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Assistant: I will inspect the directory.\nTool call (bash, call tc1): {\"command\":\"ls\"}");
		expect(result.text).toContain("Tool result (bash, call tc1): README.md");
	});

	it("budgets a paired tool call and result as one unit", () => {
		const callMarker = `CALL_${"x".repeat(300)}`;
		const resultMarker = `RESULT_${"y".repeat(300)}`;
		const activeMessage = { role: "user", content: "Active request stays", timestamp: 3 } satisfies UserMessage;
		const requiredPromptChars = buildCursorPrompt({ messages: [activeMessage] }, { charsPerToken: 1 }).text.length;
		const result = buildCursorPrompt({
			messages: [
				makeAssistant([
					{ type: "toolCall", id: "tc-budget", name: "bash", arguments: { command: callMarker } },
				], 1, "toolUse"),
				{
					role: "toolResult",
					toolCallId: "tc-budget",
					toolName: "bash",
					content: [{ type: "text", text: resultMarker }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage,
				activeMessage,
			],
		}, { maxInputTokens: requiredPromptChars + 450, charsPerToken: 1 });

		expect(result.text).toContain("User: Active request stays");
		expect(result.text).toContain("[Earlier transcript omitted: 2 messages");
		expect(result.text).not.toContain(callMarker);
		expect(result.text).not.toContain(resultMarker);
	});

	it("extracts images from latest user message only", () => {
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look at this" },
						{ type: "image", data: "oldbase64", mimeType: "image/png" },
					],
					timestamp: 1,
				} satisfies UserMessage,
				{
					role: "user",
					content: [
						{ type: "text", text: "And this one" },
						{ type: "image", data: "newbase64", mimeType: "image/jpeg" },
					],
					timestamp: 2,
				} satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.images).toHaveLength(1);
		expect(result.images[0]).toEqual({ data: "newbase64", mimeType: "image/jpeg" });
	});

	it("documents current and historical image handling", () => {
		const result = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
		expect(result.text).toContain("only active final user/developer images are attached");
		expect(result.text).toContain("prior images use deterministic transcript markers");
	});

	it("replaces historical images with placeholder text", () => {
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First" },
						{ type: "image", data: "abc", mimeType: "image/png" },
					],
					timestamp: 1,
				} satisfies UserMessage,
				{
					role: "user",
					content: "Second",
					timestamp: 2,
				} satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("[image/png image omitted from SDK history]");
		expect(result.images).toHaveLength(0);
	});

	it("budgets transcript history while preserving system prompt and latest user request", () => {
		const ctx: Context = {
			systemPrompt: ["Always preserve this system instruction."],
			messages: [
				{ role: "user", content: `old request ${"x".repeat(200)}`, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: `old answer ${"y".repeat(200)}` }],
					api: "cursor-sdk",
					provider: "cursor-sdk",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: "latest request must stay", timestamp: 3 } satisfies UserMessage,
			],
		};

		const result = buildCursorPrompt(ctx, { maxInputTokens: 120, charsPerToken: 1 });

		expect(result.text).toContain("Always preserve this system instruction.");
		expect(result.text).toContain("User: latest request must stay");
		expect(result.text).toContain("Answer the active user/developer request");
		expect(result.text).toContain("[Earlier transcript omitted: 2 messages to fit Cursor context budget]");
		expect(result.text).not.toContain("old request");
		expect(result.text).not.toContain("old answer");
	});

	it("keeps recent transcript messages that fit the budget", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: `old request ${"x".repeat(3000)}`, timestamp: 1 } satisfies UserMessage,
				{ role: "user", content: "recent request", timestamp: 2 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "recent tool output" }],
					isError: false,
					timestamp: 3,
				} satisfies ToolResultMessage,
				{ role: "user", content: "latest request", timestamp: 4 } satisfies UserMessage,
			],
		};

		const result = buildCursorPrompt(ctx, { maxInputTokens: 2200, charsPerToken: 1 });

		expect(result.text).toContain("User: latest request");
		expect(result.text).toContain("User: recent request");
		expect(result.text).toContain("Assistant: [Tool Result]\nrecent tool output");
		expect(result.text).not.toContain("old request");
	});

	it("omits oversized old tool results before older text that still fits", () => {
		const ctx: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: `large output ${"z".repeat(1200)}` }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage,
				{ role: "user", content: "recent request", timestamp: 2 } satisfies UserMessage,
				{ role: "user", content: "latest request", timestamp: 3 } satisfies UserMessage,
			],
		};

		const result = buildCursorPrompt(ctx, { maxInputTokens: 1900, charsPerToken: 1 });

		expect(result.text).toContain("User: latest request");
		expect(result.text).toContain("User: recent request");
		expect(result.text).toContain("[Earlier transcript omitted: 1 message to fit Cursor context budget]");
		expect(result.text).not.toContain("large output");
	});

	it("appends answer instruction and tool tail guard", () => {
		const ctx: Context = {
			messages: [{ role: "user", content: "test", timestamp: 1 }],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain("Answer the active user/developer request");
		expect(result.text.endsWith(getCursorToolTailGuardText())).toBe(true);
	});

	it("places tool manifest after boundary and before system instructions when provided", () => {
		const ctx: Context = {
			systemPrompt: ["Be helpful."],
			messages: [{ role: "user", content: "test", timestamp: 1 }],
		};
		const manifest = "Callable tool surfaces this run:\n- sample";
		const result = buildCursorPrompt(ctx, { toolManifest: manifest });
		expect(result.text).toContain(manifest);
		expect(result.text.indexOf("Cursor SDK tool boundary:")).toBeLessThan(result.text.indexOf(manifest));
		expect(result.text.indexOf(manifest)).toBeLessThan(result.text.indexOf("System instructions from OMP:"));
	});

	it("omits tool manifest by default", () => {
		const result = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
		expect(result.text).not.toContain("Callable tool surfaces this run:");
	});

	it("uses compact pi-bridge framing when bridge guidance is disabled", () => {
		const ctx: Context = {
			systemPrompt: ["Reply with code only."],
			messages: [{ role: "user", content: "def add(a, b):", timestamp: 1 }],
			tools: [],
		};
		const defaultPrompt = buildCursorPrompt(ctx, { charsPerToken: 1 });
		const compactPrompt = buildCursorPrompt(ctx, { charsPerToken: 1, includePiBridgeGuidance: false });

		expect(compactPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(compactPrompt.text).toContain("Call only Cursor SDK/MCP tools exposed in this run");
		expect(compactPrompt.text).toContain("Reply with code only.");
		expect(compactPrompt.text).toContain("User: def add(a, b):");
		expect(compactPrompt.text).not.toContain("Bridged pi tools:");
		expect(compactPrompt.text).not.toContain("Use pi__cursor_ask_question");
		expect(compactPrompt.text).not.toContain("Exposed pi__* bridge tools");
		expect(compactPrompt.text).not.toContain("prefer pi__mcp");
		expect(defaultPrompt.text.length - compactPrompt.text.length).toBeGreaterThan(100);

		const planPrompt = buildCursorPrompt(ctx, { agentMode: "plan", includePiBridgeGuidance: false });
		expect(planPrompt.text).toContain("Cursor SDK mode is plan for this run");
		expect(planPrompt.text).not.toContain("Exposed pi__* bridge tools");
		const incrementalPlanPrompt = buildCursorIncrementalPrompt(ctx, { agentMode: "plan", includePiBridgeGuidance: false });
		expect(incrementalPlanPrompt.text).toContain("Cursor SDK mode is plan for this run");
		expect(incrementalPlanPrompt.text).not.toContain("Exposed pi__* bridge tools");
		expect(incrementalPlanPrompt.text).not.toContain("prefer pi__mcp");
	});

	it("keeps pi-bridge framing when context tools are present or unknown", () => {
		const readTool: NonNullable<Context["tools"]>[number] = {
			name: "read",
			description: "Read files",
			parameters: Type.Object({}),
		};
		const withTools = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }], tools: [readTool] });
		const unknownTools = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });

		expect(withTools.text).toContain("For exposed OMP bridge tools");
		expect(withTools.text).toContain("Use pi__cursor_ask_question");
		expect(unknownTools.text).toContain("For exposed OMP bridge tools");
		expect(unknownTools.text).toContain("Use pi__cursor_ask_question");

		const unknownToolsPlan = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] }, { agentMode: "plan" });
		expect(unknownToolsPlan.text).toContain("Exposed pi__* bridge tools");
	});

	it("instructs Cursor not to claim web search without an actual Cursor web tool", () => {
		const ctx: Context = {
			systemPrompt: ["You can use WebSearch and WebFetch."],
			messages: [{ role: "user", content: "search the web for Cursor SDK best practices", timestamp: 1 }],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text.indexOf("Cursor SDK tool boundary:")).toBeLessThan(result.text.indexOf("System instructions from OMP:"));
		expect(result.text).toContain("OMP history names, replay labels, and transcript names are not callable");
		expect(result.text).toContain("call pi__* MCP names");
		expect(result.text).toContain("not OMP card/history names");
		expect(result.text).toContain("Do not claim OMP-side or WebSearch/WebFetch tools");
		expect(result.text).toContain("Use pi__cursor_ask_question for material choices if exposed");
		expect(result.text).toContain("prefer pi__mcp for MCP work and pi__subagent for delegation");
		expect(result.text).not.toContain("OMP bridge contract:");
		expect(result.text).not.toContain("do not use SwitchMode");
	});

	it("omits manifest pointer from boundary when tool manifest is disabled", () => {
		const result = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
		expect(result.text).not.toContain("See callable surfaces below.");
	});

	it("points boundary readers to the manifest when tool manifest is present", () => {
		const manifest = "Callable tool surfaces this run:\n- sample";
		const result = buildCursorPrompt(
			{ messages: [{ role: "user", content: "test", timestamp: 1 }] },
			{ toolManifest: manifest },
		);
		expect(result.text).toContain("See callable surfaces below.");
		expect(result.text).toContain(manifest);
	});

	it("includes shell cd hint in the tool tail guard", () => {
		const tail = getCursorToolTailGuardText();
		expect(tail).toContain("explicit `cd`");
		expect(tail).toContain("session cwd may differ from tool args");
		expect(tail).toContain("Exact-output requests");
		const bootstrap = buildCursorPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
		const incremental = buildCursorIncrementalPrompt({ messages: [{ role: "user", content: "test", timestamp: 1 }] });
		expect(bootstrap.text).toContain("explicit `cd`");
		expect(incremental.text).toContain("explicit `cd`");
		expect(incremental.text).toContain("prefer pi__mcp for MCP work and pi__subagent for delegation");
	});

	it("adds plan-mode guidance without disabling inspection tools", () => {
		const context = { messages: [{ role: "user" as const, content: "test", timestamp: 1 }] };
		const bootstrap = buildCursorPrompt(context, { agentMode: "plan" });
		const incremental = buildCursorIncrementalPrompt(context, { agentMode: "plan" });

		expect(bootstrap.text.match(/Cursor SDK mode is plan for this run/g)).toHaveLength(1);
		expect(bootstrap.text).toContain("Safe/read-only shell commands");
		expect(bootstrap.text).toContain("Exposed pi__* bridge tools are also callable in plan mode");
		expect(incremental.text.match(/Cursor SDK mode is plan for this run/g)).toHaveLength(1);
		expect(buildCursorPrompt(context).text).not.toContain("Cursor SDK mode is plan for this run");
	});
});

describe("OMP built-in Cursor semantic parity", () => {
	it("preserves prior turn order, omits thinking, and separates an active developer request", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "First request", timestamp: 1 },
				makeAssistant([
					{ type: "thinking", thinking: "private chain" },
					{ type: "text", text: "First answer" },
				], 2),
				{ role: "developer", content: "Active developer request", timestamp: 3 },
			],
		};

		const reference = JSON.stringify(buildBuiltInSemanticReference(context).rootPromptMessagesJson);
		const prompt = buildCursorPrompt(context).text;

		expect(reference).toContain("First request");
		expect(reference).toContain("First answer");
		expect(reference).not.toContain("Active developer request");
		expect(reference).not.toContain("private chain");
		expect(prompt.indexOf("User: First request")).toBeLessThan(prompt.indexOf("Assistant: First answer"));
		expect(prompt.indexOf("Assistant: First answer")).toBeLessThan(prompt.indexOf("Developer: Active developer request"));
		expect(prompt).not.toContain("private chain");
	});

	it("does not invent an active request or resend old images after a final assistant message", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Prior image request" },
						{ type: "image", data: "YWJj", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				makeAssistant([{ type: "text", text: "Completed answer" }], 2),
			],
		};

		const reference = JSON.stringify(buildBuiltInSemanticReference(context).rootPromptMessagesJson);
		const prompt = buildCursorPrompt(context);

		expect(reference).toContain("Completed answer");
		expect(prompt.images).toEqual([]);
		expect(prompt.text).toContain("Continue from the reconciled OMP conversation state");
		expect(prompt.text).not.toContain("Answer the active user/developer request");
	});

	it("keeps paired tool success/error results and matches orphan fallback policy", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Run tools", timestamp: 1 },
				makeAssistant([
					{ type: "toolCall", id: "image-call", name: "read_image", arguments: {} },
					{ type: "toolCall", id: "error-call", name: "bash", arguments: { command: "false" } },
				], 2, "toolUse"),
				{
					role: "toolResult",
					toolCallId: "image-call",
					toolName: "read_image",
					content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "error-call",
					toolName: "bash",
					content: [{ type: "text", text: "exit 1" }],
					isError: true,
					timestamp: 4,
				},
				{
					role: "toolResult",
					toolCallId: "orphan",
					toolName: "bash",
					content: [{ type: "text", text: "orphan failure" }],
					isError: true,
					timestamp: 5,
				},
				{ role: "user", content: "Continue", timestamp: 6 },
			],
		};

		const reference = JSON.stringify(buildBuiltInSemanticReference(context).rootPromptMessagesJson);
		const prompt = buildCursorPrompt(context).text;

		expect(reference).toContain('"role":"tool"');
		expect(reference).toContain("[image/png image]");
		expect(reference).toContain("[Tool Error]\\norphan failure");
		expect(prompt).toContain("Tool result (read_image, call image-call): [image/png image]");
		expect(prompt).toContain("Tool error (bash, call error-call): exit 1");
		expect(prompt).toContain("Assistant: [Tool Error]\norphan failure");
	});

	it("attaches only the active image and marks prior images deterministically", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Prior image" },
						{ type: "image", data: "YWJj", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Active image" },
						{ type: "image", data: "ZGVm", mimeType: "image/jpeg" },
					],
					timestamp: 2,
				},
			],
		};

		const reference = JSON.stringify(buildBuiltInSemanticReference(context).rootPromptMessagesJson);
		const prompt = buildCursorPrompt(context);

		expect(reference).toContain("data:image/png;base64,YWJj");
		expect(reference).not.toContain("ZGVm");
		expect(prompt.text).toContain("[image/png image omitted from SDK history]");
		expect(prompt.text).not.toContain("[image/jpeg image omitted from SDK history]");
		expect(prompt.images).toEqual([{ data: "ZGVm", mimeType: "image/jpeg" }]);
	});

	it("uses OMP summary conversion once and preserves summary chronology", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Before summaries", timestamp: 1 },
				{
					role: "branchSummary",
					summary: "Branch semantic marker",
					fromId: "entry-a",
					timestamp: 2,
				} as unknown as Context["messages"][number],
				{
					role: "compactionSummary",
					summary: "Compaction semantic marker",
					tokensBefore: 12000,
					timestamp: 3,
				} as unknown as Context["messages"][number],
				{ role: "user", content: "Active after summaries", timestamp: 4 },
			],
		};

		const reference = JSON.stringify(buildBuiltInSemanticReference(context).rootPromptMessagesJson);
		const prompt = buildCursorPrompt(context).text;

		expect(reference.match(/Branch semantic marker/g)).toHaveLength(1);
		expect(reference.match(/Compaction semantic marker/g)).toHaveLength(1);
		expect(prompt.match(/Branch semantic marker/g)).toHaveLength(1);
		expect(prompt.match(/Compaction semantic marker/g)).toHaveLength(1);
		expect(prompt.indexOf("Before summaries")).toBeLessThan(prompt.indexOf("Branch semantic marker"));
		expect(prompt.indexOf("Branch semantic marker")).toBeLessThan(prompt.indexOf("Compaction semantic marker"));
		expect(prompt.indexOf("Compaction semantic marker")).toBeLessThan(prompt.indexOf("Active after summaries"));
	});
});

describe("cursor session prompt assembly", () => {
	it("bootstraps the first send with the full Cursor prompt", () => {
		const context: Context = {
			systemPrompt: ["Be helpful."],
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const sendState = { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 };
		const plan = planCursorSessionSend(sendState, context);
		const prompt = buildCursorSessionSendPrompt(context, {}, plan);

		expect(plan.mode).toBe("bootstrap");
		expect(prompt.text).toContain("Cursor SDK tool boundary:");
		expect(prompt.text).toContain("User: Hello");
	});

	it("sends an incremental prompt after a bootstrapped session agent send", () => {
		const priorContext: Context = {
			systemPrompt: ["Be helpful."],
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "Hi" }], api: "cursor-sdk", provider: "cursor-sdk", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			],
		};
		const context: Context = {
			systemPrompt: ["Be helpful."],
			messages: [...priorContext.messages, { role: "user", content: "Follow up", timestamp: 3 }],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: 1,
		};
		const plan = planCursorSessionSend(sendState, context);
		const prompt = buildCursorSessionSendPrompt(context, {}, plan);

		expect(plan.mode).toBe("incremental");
		expect(prompt.text).toContain("Continue the conversation using Cursor SDK capabilities only");
		expect(prompt.text).toContain("User: Follow up");
		expect(prompt.text).not.toContain("Cursor SDK tool boundary:");
		expect(prompt.text).not.toContain("System instructions from OMP:");
		expect(prompt.text).not.toContain("Be helpful.");
		expect(prompt.text).not.toContain("User: Hello");
	});

	it("rebootstraps after branch shrink using shouldBootstrapCursorContext", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint({
				messages: [
					{ role: "user", content: "Hello", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "Hi" }], api: "cursor-sdk", provider: "cursor-sdk", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
				],
			}),
			incrementalSendCount: 0,
		};

		expect(shouldBootstrapCursorContext(sendState, context)).toBe(true);
		expect(planCursorSessionSend(sendState, context).mode).toBe("bootstrap");
	});

	it("rebootstraps when same-length history diverges", () => {
		const priorContext: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const editedContext: Context = {
			messages: [{ role: "user", content: "Hello edited", timestamp: 1 }],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: 0,
		};

		expect(shouldBootstrapCursorContext(sendState, editedContext)).toBe(true);
		expect(planCursorSessionSend(sendState, editedContext).mode).toBe("bootstrap");
	});

	it("rebootstraps with current system instructions when the system context diverges", () => {
		const priorContext: Context = {
			systemPrompt: ["Previous invariant instruction."],
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const context: Context = {
			systemPrompt: ["Current invariant instruction."],
			messages: priorContext.messages,
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: 0,
		};
		const plan = planCursorSessionSend(sendState, context);
		const prompt = buildCursorSessionSendPrompt(context, {}, plan);

		expect(plan).toMatchObject({ mode: "bootstrap", reason: "context_divergence" });
		expect(prompt.text).toContain("System instructions from OMP:\nCurrent invariant instruction.");
		expect(prompt.text).not.toContain("Previous invariant instruction.");
	});

	it("omits invariant bootstrap instructions from incremental prompts", () => {
		const incremental = buildCursorIncrementalPrompt({
			systemPrompt: ["Be helpful."],
			messages: [{ role: "user", content: "Follow up", timestamp: 3 }],
		});
		expect(incremental.text).not.toContain("Cursor SDK tool boundary:");
		expect(incremental.text).not.toContain("System instructions from OMP:");
		expect(incremental.text).not.toContain("Be helpful.");
		expect(incremental.text).toContain("Continue the conversation using Cursor SDK capabilities only");
		expect(incremental.text).toContain(getCursorToolTailGuardText());
	});

	it("ends bootstrap and incremental prompts with the tool tail guard", () => {
		const context: Context = {
			systemPrompt: ["Be helpful."],
			messages: [{ role: "user", content: "Follow up", timestamp: 3 }],
		};
		const bootstrap = buildCursorPrompt(context);
		const incremental = buildCursorIncrementalPrompt(context);
		const tail = getCursorToolTailGuardText();

		expect(bootstrap.text.endsWith(tail)).toBe(true);
		expect(incremental.text.endsWith(tail)).toBe(true);
	});

	it("preserves the latest user request and tail guard in incremental prompts under budget pressure", () => {
		const incremental = buildCursorIncrementalPrompt(
			{
				systemPrompt: ["Long pi system prompt. ".repeat(20)],
				messages: [{ role: "user", content: "Keep this exact follow-up request", timestamp: 3 }],
			},
			{ maxInputTokens: 80, charsPerToken: 1 },
		);

		expect(incremental.text).not.toContain("Long pi system prompt.");
		expect(incremental.text).toContain("User: Keep this exact follow-up request");
		expect(incremental.text).toContain(getCursorToolTailGuardText());
	});

	it("includes branch summaries from /tree navigation in bootstrap prompts", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "branchSummary",
					summary: "We explored approach A and decided against it.",
					fromId: "entry-a",
					timestamp: 2,
				} as unknown as Context["messages"][number],
				{ role: "user", content: "Continue on approach B", timestamp: 3 },
			],
		};

		const prompt = buildCursorPrompt(context);

		expect(prompt.text).toContain("Branch-return summary:");
		expect(prompt.text.match(/We explored approach A and decided against it\./g)).toHaveLength(1);
		expect(prompt.text).toContain("User: Continue on approach B");
	});

	it("rebootstraps when /tree adds a branch summary to the active context", () => {
		const priorContext: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const treeContext: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "branchSummary",
					summary: "Abandoned branch details",
					fromId: "entry-a",
					timestamp: 2,
				} as unknown as Context["messages"][number],
			],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: 0,
		};

		expect(shouldBootstrapCursorContext(sendState, treeContext)).toBe(true);
		expect(planCursorSessionSend(sendState, treeContext).mode).toBe("bootstrap");
	});

	it("includes compaction summaries in bootstrap prompts", () => {
		const context: Context = {
			messages: [
				{
					role: "compactionSummary",
					summary: "Earlier work covered auth setup.",
					tokensBefore: 12000,
					timestamp: 1,
				} as unknown as Context["messages"][number],
				{ role: "user", content: "Continue", timestamp: 2 },
			],
		};

		const prompt = buildCursorPrompt(context);

		expect(prompt.text).toContain("Prior model work/tool state available.");
		expect(prompt.text.match(/Earlier work covered auth setup\./g)).toHaveLength(1);
	});
});

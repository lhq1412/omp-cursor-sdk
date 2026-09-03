import { describe, expect, it, vi, type Mock } from "vitest";
import type { CursorExecHandlers, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	createCursorOmpExecCustomTools,
	isCursorOmpExecToolCall,
	resolveCursorProviderExecHandlers,
	toolResultMessageToSdkCustomToolResult,
} from "../src/cursor-omp-exec-adapter.js";

function okResult(text = "ok"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc",
		toolName: "tool",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

async function exec(
	handlers: CursorExecHandlers,
	name: string,
	args: Record<string, unknown>,
	toolCallId = "tc",
) {
	const tools = createCursorOmpExecCustomTools(handlers);
	return tools[name]!.execute(args as never, { toolCallId });
}

describe("createCursorOmpExecCustomTools routing", () => {
	it.each([
		{
			name: "read prefers piRead with raw path/offset/limit",
			tool: "read",
			args: { path: "file.ts", offset: 10, limit: 5 },
			handlers: ["piRead", "read"] as const,
			expected: "piRead",
			call: [{ args: { path: "file.ts", offset: 10, limit: 5 }, toolCallId: "tc" }],
		},
		{
			name: "read falls back to legacy read",
			tool: "read",
			args: { path: "file.ts", offset: 2, limit: 3 },
			handlers: ["read"] as const,
			expected: "read",
			call: [{ path: "file.ts", toolCallId: "tc", offset: 2, limit: 3 }],
		},
		{
			name: "shell with workingDirectory prefers shellStream over piBash",
			tool: "shell",
			args: { command: "ls", workingDirectory: "/tmp" },
			handlers: ["shellStream", "shell", "piBash"] as const,
			expected: "shellStream",
			call: [{ command: "ls", workingDirectory: "/tmp", toolCallId: "tc" }],
		},
		{
			name: "shell with workingDirectory uses shell not piBash",
			tool: "shell",
			args: { command: "ls", workingDirectory: "/tmp", timeout: 30 },
			handlers: ["shell", "piBash"] as const,
			expected: "shell",
			call: [{ command: "ls", workingDirectory: "/tmp", timeout: 30, toolCallId: "tc" }],
		},
		{
			name: "shell without workingDirectory uses piBash",
			tool: "shell",
			args: { command: "ls", timeout: 12 },
			handlers: ["piBash", "shell"] as const,
			expected: "piBash",
			call: [{ args: { command: "ls", timeout: 12 }, toolCallId: "tc" }],
		},
		{
			name: "shell without workingDirectory falls back to shell",
			tool: "shell",
			args: { command: "ls" },
			handlers: ["shell"] as const,
			expected: "shell",
			call: [{ command: "ls", toolCallId: "tc" }],
		},
		{
			name: "write prefers piWrite with fileText",
			tool: "write",
			args: { path: "a.txt", fileText: "hello" },
			handlers: ["piWrite", "write"] as const,
			expected: "piWrite",
			call: [{ args: { path: "a.txt", content: "hello" }, toolCallId: "tc" }],
		},
		{
			name: "write maps content onto piWrite",
			tool: "write",
			args: { path: "a.txt", content: "hello" },
			handlers: ["piWrite"] as const,
			expected: "piWrite",
			call: [{ args: { path: "a.txt", content: "hello" }, toolCallId: "tc" }],
		},
		{
			name: "write falls back to legacy write",
			tool: "write",
			args: { path: "a.txt", fileText: "hello" },
			handlers: ["write"] as const,
			expected: "write",
			call: [{ path: "a.txt", fileText: "hello", toolCallId: "tc" }],
		},
		{
			name: "edit maps edits[] onto piEdit",
			tool: "edit",
			args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
			handlers: ["piEdit"] as const,
			expected: "piEdit",
			call: [{ args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, toolCallId: "tc" }],
		},
		{
			name: "edit maps oldText/newText onto piEdit",
			tool: "edit",
			args: { path: "a.ts", oldText: "a", newText: "b" },
			handlers: ["piEdit"] as const,
			expected: "piEdit",
			call: [{ args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, toolCallId: "tc" }],
		},
		{
			name: "edit maps old_string/new_string onto piEdit",
			tool: "edit",
			args: { path: "a.ts", old_string: "a", new_string: "b" },
			handlers: ["piEdit"] as const,
			expected: "piEdit",
			call: [{ args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, toolCallId: "tc" }],
		},
		{
			name: "grep prefers piGrep with ignoreCase and headLimit",
			tool: "grep",
			args: { pattern: "foo", path: "src", glob: "*.ts", caseInsensitive: true, headLimit: 20 },
			handlers: ["piGrep", "grep"] as const,
			expected: "piGrep",
			call: [{
				args: { pattern: "foo", path: "src", glob: "*.ts", ignoreCase: true, limit: 20 },
				toolCallId: "tc",
			}],
		},
		{
			name: "grep falls back to legacy grep with piGrepSkip",
			tool: "grep",
			args: { pattern: "foo", path: "src", caseInsensitive: true, offset: 4 },
			handlers: ["grep"] as const,
			expected: "grep",
			call: [{ pattern: "foo", toolCallId: "tc", path: "src", caseInsensitive: true, offset: 4 }],
		},
		{
			name: "glob uses piFind with globPattern and targetDirectory",
			tool: "glob",
			args: { globPattern: "**/*.ts", targetDirectory: "src", limit: 8 },
			handlers: ["piFind"] as const,
			expected: "piFind",
			call: [{ args: { pattern: "**/*.ts", path: "src", limit: 8 }, toolCallId: "tc" }],
		},
		{
			name: "glob maps pattern/path onto piFind",
			tool: "glob",
			args: { pattern: "*.js", path: "lib" },
			handlers: ["piFind"] as const,
			expected: "piFind",
			call: [{ args: { pattern: "*.js", path: "lib" }, toolCallId: "tc" }],
		},
		{
			name: "ls prefers piLs with piLsPath",
			tool: "ls",
			args: {},
			handlers: ["piLs", "ls"] as const,
			expected: "piLs",
			call: [{ args: { path: "." }, toolCallId: "tc" }],
		},
		{
			name: "ls falls back to legacy ls",
			tool: "ls",
			args: { path: "src", ignore: ["node_modules"] },
			handlers: ["ls"] as const,
			expected: "ls",
			call: [{ path: "src", toolCallId: "tc", ignore: ["node_modules"] }],
		},
		{
			name: "delete uses legacy delete",
			tool: "delete",
			args: { path: "gone.txt" },
			handlers: ["delete"] as const,
			expected: "delete",
			call: [{ path: "gone.txt", toolCallId: "tc" }],
		},
	])("$name", async ({ tool, args, handlers, expected, call }) => {
		const mocks = Object.fromEntries(
			handlers.map((handler) => [handler, vi.fn(async () => okResult())]),
		) as CursorExecHandlers;
		const result = await exec(mocks, tool, args);
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
		const mock = mocks[expected as keyof CursorExecHandlers] as Mock;
		expect(mock).toHaveBeenCalledTimes(1);
		expect(mock.mock.calls[0][0]).toEqual(call[0]);
		if (expected === "shellStream") {
			expect(mock.mock.calls[0][1]).toEqual({
				onStdout: expect.any(Function),
				onStderr: expect.any(Function),
			});
		}
		for (const handler of handlers) {
			if (handler !== expected) {
				expect(mocks[handler as keyof CursorExecHandlers]).not.toHaveBeenCalled();
			}
		}
	});

	it("does not pre-apply piReadPath", async () => {
		const piRead = vi.fn(async () => okResult());
		await exec({ piRead }, "read", { path: "src/file.ts", offset: 3, limit: 7 });
		expect(piRead).toHaveBeenCalledWith({
			args: { path: "src/file.ts", offset: 3, limit: 7 },
			toolCallId: "tc",
		});
	});

	it("returns Tool not available when the handler is missing", async () => {
		expect(await exec({}, "read", { path: "a.ts" })).toEqual({
			content: [{ type: "text", text: "Tool not available" }],
			isError: true,
		});
	});

	it("returns Tool not available for patch-only edit", async () => {
		const piEdit = vi.fn(async () => okResult());
		expect(await exec({ piEdit }, "edit", { path: "a.ts", patchContent: "@@ -1 +1 @@" })).toEqual({
			content: [{ type: "text", text: "Tool not available" }],
			isError: true,
		});
		expect(piEdit).not.toHaveBeenCalled();
	});

	it("returns isError true with the thrown message", async () => {
		expect(await exec({
			piRead: async () => {
				throw new Error("boom");
			},
		}, "read", { path: "a.ts" })).toEqual({
			content: [{ type: "text", text: "boom" }],
			isError: true,
		});
	});

	it("keeps rejected OMP results as isError false", async () => {
		const result = await exec({
			piRead: async () => ({
				role: "toolResult",
				toolCallId: "tc",
				toolName: "read",
				content: [{ type: "text", text: "User rejected" }],
				isError: false,
				timestamp: 1,
			}),
		}, "read", { path: "a.ts" });
		expect(result).toEqual({
			content: [{ type: "text", text: "User rejected" }],
			isError: false,
		});
	});

	it("invokes the handler once per execute", async () => {
		const piRead = vi.fn(async () => okResult());
		await exec({ piRead }, "read", { path: "a.ts" });
		expect(piRead).toHaveBeenCalledTimes(1);
	});


	it("reports ToolResultMessage to onResolved for success and missing-handler paths", async () => {
		const onResolved = vi.fn();
		const tools = createCursorOmpExecCustomTools({ piRead: async () => okResult("file") }, onResolved);
		await tools.read!.execute({ path: "a.ts" }, { toolCallId: "tc" });
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(onResolved.mock.calls[0]?.[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "tc",
			toolName: "tool",
			isError: false,
		});

		onResolved.mockClear();
		const missing = createCursorOmpExecCustomTools({}, onResolved);
		await missing.read!.execute({ path: "a.ts" }, { toolCallId: "missing" });
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(onResolved.mock.calls[0]?.[0]).toMatchObject({
			toolCallId: "missing",
			toolName: "read",
			isError: true,
		});
	});
});

describe("resolveCursorProviderExecHandlers", () => {
	it("prefers cursorExecHandlers over execHandlers", () => {
		const cursorExecHandlers: CursorExecHandlers = {};
		const execHandlers: CursorExecHandlers = {};
		expect(resolveCursorProviderExecHandlers({ cursorExecHandlers, execHandlers })).toBe(cursorExecHandlers);
		expect(resolveCursorProviderExecHandlers({ execHandlers })).toBe(execHandlers);
		expect(resolveCursorProviderExecHandlers({})).toBeUndefined();
		expect(resolveCursorProviderExecHandlers()).toBeUndefined();
	});
});

describe("toolResultMessageToSdkCustomToolResult", () => {
	it("uses empty text when there is no text content", () => {
		expect(toolResultMessageToSdkCustomToolResult({
			role: "toolResult",
			toolCallId: "tc",
			toolName: "read",
			content: [],
			isError: false,
			timestamp: 1,
		})).toEqual({
			content: [{ type: "text", text: "" }],
			isError: false,
		});
	});
});

describe("isCursorOmpExecToolCall", () => {
	it("matches custom-user-tools MCP envelopes and ignores native builtins", () => {
		expect(isCursorOmpExecToolCall({ type: "mcp", args: { providerIdentifier: "custom-user-tools", toolName: "read" } })).toBe(true);
		expect(isCursorOmpExecToolCall({ type: "mcp", args: { toolName: "read" } })).toBe(true);
		expect(isCursorOmpExecToolCall({ type: "mcp", args: { toolName: "pi__sem_reindex" } })).toBe(false);
		expect(isCursorOmpExecToolCall({ type: "read", args: { path: "a.ts" } })).toBe(false);
		expect(isCursorOmpExecToolCall({ type: "shell", args: { command: "ls" } })).toBe(false);
	});
});

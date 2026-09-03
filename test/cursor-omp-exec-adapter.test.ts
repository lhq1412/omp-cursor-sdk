import { describe, expect, it, vi, type Mock } from "vitest";
import type { CursorExecHandlers, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	createCursorOmpExecCustomTools,
	CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES,
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
			name: "shell uses piBash regardless of workingDirectory compatibility input",
			tool: "shell",
			args: { command: "ls", workingDirectory: "/tmp" },
			handlers: ["piBash", "shell", "shellStream"] as const,
			expected: "piBash",
			call: [{ args: { command: "ls" }, toolCallId: "tc" }],
		},
		{
			name: "shell preserves timeout 0 through piBash",
			tool: "shell",
			args: { command: "ls", timeout: 0 },
			handlers: ["piBash", "shell", "shellStream"] as const,
			expected: "piBash",
			call: [{ args: { command: "ls", timeout: 0 }, toolCallId: "tc" }],
		},
		{
			name: "shell falls back to legacy shell with workingDirectory",
			tool: "shell",
			args: { command: "ls", workingDirectory: "/tmp", timeout: 30 },
			handlers: ["shell", "shellStream"] as const,
			expected: "shell",
			call: [{ command: "ls", workingDirectory: "/tmp", timeout: 30, toolCallId: "tc" }],
		},
		{
			name: "shell falls back to shellStream without injecting process cwd",
			tool: "shell",
			args: { command: "ls", timeout: 12 },
			handlers: ["shellStream"] as const,
			expected: "shellStream",
			call: [{ command: "ls", timeout: 12, toolCallId: "tc" }],
		},
		{
			name: "write prefers piWrite with canonical content",
			tool: "write",
			args: { path: "a.txt", content: "hello" },
			handlers: ["piWrite", "write"] as const,
			expected: "piWrite",
			call: [{ args: { path: "a.txt", content: "hello" }, toolCallId: "tc" }],
		},
		{
			name: "write retains fileText parsing compatibility",
			tool: "write",
			args: { path: "a.txt", fileText: "hello" },
			handlers: ["piWrite"] as const,
			expected: "piWrite",
			call: [{ args: { path: "a.txt", content: "hello" }, toolCallId: "tc" }],
		},
		{
			name: "write maps canonical content onto legacy write",
			tool: "write",
			args: { path: "a.txt", content: "hello" },
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
			name: "grep prefers piGrep with modern options",
			tool: "grep",
			args: { pattern: "foo", path: "src", glob: "*.ts", ignoreCase: true, literal: true, context: 2, limit: 20 },
			handlers: ["piGrep", "grep"] as const,
			expected: "piGrep",
			call: [{
				args: { pattern: "foo", path: "src", glob: "*.ts", ignoreCase: true, literal: true, context: 2, limit: 20 },
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
			name: "glob maps canonical pattern/path/limit onto piFind",
			tool: "glob",
			args: { pattern: "**/*.ts", path: "src", limit: 8 },
			handlers: ["piFind"] as const,
			expected: "piFind",
			call: [{ args: { pattern: "**/*.ts", path: "src", limit: 8 }, toolCallId: "tc" }],
		},
		{
			name: "glob retains globPattern/targetDirectory parsing compatibility",
			tool: "glob",
			args: { globPattern: "*.js", targetDirectory: "lib" },
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

	describe("input schemas", () => {
		const tools = createCursorOmpExecCustomTools({});

		it.each([
			["read", ["path"], ["path", "offset", "limit"]],
			["shell", ["command"], ["command", "timeout"]],
			["write", ["path", "content"], ["path", "content"]],
			["edit", ["path", "edits"], ["path", "edits"]],
			["grep", ["pattern"], ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]],
			["glob", ["pattern"], ["pattern", "path", "limit"]],
			["ls", undefined, ["path"]],
			["delete", ["path"], ["path"]],
		] as const)("%s advertises only executable canonical fields", (name, required, properties) => {
			const schema = tools[name]!.inputSchema!;
			expect(schema).toMatchObject({ type: "object", additionalProperties: false });
			expect(schema.required).toEqual(required);
			expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(properties);
		});

		it("requires complete replacement objects and does not advertise patchContent", () => {
			expect(tools.edit!.inputSchema).toMatchObject({
				properties: {
					edits: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							required: ["oldText", "newText"],
							additionalProperties: false,
						},
					},
				},
			});
		});
	});

	it("omits custom tools whose OMP builtins are inactive", () => {
		const handlers: CursorExecHandlers = {
			piRead: async () => okResult(),
			piBash: async () => okResult(),
			piWrite: async () => okResult(),
		};
		expect(Object.keys(createCursorOmpExecCustomTools(handlers, new Set(["read", "bash"]))).sort()).toEqual([
			"delete",
			"ls",
			"read",
			"shell",
		]);
		expect(Object.keys(createCursorOmpExecCustomTools(handlers, new Set())).sort()).toEqual(["delete"]);
		expect(Object.keys(createCursorOmpExecCustomTools(handlers)).sort()).toEqual([...CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES].sort());
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
		const tools = createCursorOmpExecCustomTools({ piRead: async () => okResult("file") }, undefined, onResolved);
		await tools.read!.execute({ path: "a.ts" }, { toolCallId: "tc" });
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(onResolved.mock.calls[0]?.[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "tc",
			toolName: "tool",
			isError: false,
		});

		onResolved.mockClear();
		const missing = createCursorOmpExecCustomTools({}, undefined, onResolved);
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

	it("preserves image content", () => {
		expect(toolResultMessageToSdkCustomToolResult({
			role: "toolResult",
			toolCallId: "tc",
			toolName: "read",
			content: [
				{ type: "text", text: "preview" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		})).toEqual({
			content: [
				{ type: "text", text: "preview" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
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

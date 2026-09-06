import { describe, expect, it, vi } from "vitest";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { CursorExecHandlers, CursorMcpCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { normalizeMcpInputSchema } from "../src/cursor-pi-tool-bridge-snapshot.js";
import {
	CURSOR_OMP_EXTENSION_CUSTOM_TOOLS_ENV,
	buildCursorOmpExtensionToolSpecs,
	buildCursorOmpExtensionToolSurfaceSignature,
	createCursorOmpExtensionCustomTools,
	listActiveCursorOmpExecCustomToolSdkNames,
	mergeCursorOmpCustomTools,
	prefersCursorOmpExtensionCustomTools,
	toolResultMessageToSdkCustomToolResult,
	type CursorOmpExtensionToolSpec,
} from "../src/cursor-omp-exec-adapter.js";

function okResult(toolName: string, text: string, toolCallId = "tc"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function registryHandlers(
	registry: Map<string, (call: CursorMcpCall) => Promise<ToolResultMessage> | ToolResultMessage>,
): CursorExecHandlers {
	return {
		mcp: async (call) => {
			const run = registry.get(call.toolName);
			if (!run) {
				return {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					content: [{ type: "text", text: `MCP tool "${call.toolName}" not found` }],
					isError: true,
					timestamp: Date.now(),
				};
			}
			return run(call);
		},
	};
}

const echoSpec: CursorOmpExtensionToolSpec = {
	name: "echo_ext",
	description: "echo",
	inputSchema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
};

describe("createCursorOmpExtensionCustomTools (PR0 mcp path)", () => {
	it("exposes only the active tool snapshot", () => {
		const tools = createCursorOmpExtensionCustomTools({}, [echoSpec, { name: "other" }]);
		expect(Object.keys(tools).sort()).toEqual(["echo_ext", "other"]);
		expect(createCursorOmpExtensionCustomTools({}, [])).toEqual({});
	});

	it("skips blank and duplicate names", () => {
		const tools = createCursorOmpExtensionCustomTools({}, [
			{ name: "" },
			echoSpec,
			{ name: "echo_ext", description: "dup" },
		]);
		expect(Object.keys(tools)).toEqual(["echo_ext"]);
		expect(tools.echo_ext?.description).toBe("echo");
	});

	it("executes the registry tool via handlers.mcp with stable call shape", async () => {
		const seen: CursorMcpCall[] = [];
		const instance = vi.fn(async (call: CursorMcpCall) => {
			seen.push(call);
			return okResult(call.toolName, `echo:${String(call.args.text)}`, call.toolCallId);
		});
		const handlers = registryHandlers(new Map([["echo_ext", instance]]));
		const tools = createCursorOmpExtensionCustomTools(handlers, [echoSpec], undefined, {
			providerIdentifier: "omp-test",
		});

		const result = await tools.echo_ext!.execute({ text: "hi" } as never, { toolCallId: "call-1" });

		expect(instance).toHaveBeenCalledTimes(1);
		expect(seen[0]).toEqual({
			name: "echo_ext",
			providerIdentifier: "omp-test",
			toolName: "echo_ext",
			toolCallId: "call-1",
			args: { text: "hi" },
			rawArgs: {},
		});
		expect(result).toEqual(
			toolResultMessageToSdkCustomToolResult(okResult("echo_ext", "echo:hi", "call-1")),
		);
	});

	it("does not expose or execute tools absent from the snapshot", async () => {
		const closed = vi.fn(async () => okResult("closed_ext", "should-not-run"));
		const handlers = registryHandlers(new Map([["closed_ext", closed]]));
		const tools = createCursorOmpExtensionCustomTools(handlers, [echoSpec]);
		expect(tools.closed_ext).toBeUndefined();
		expect(closed).not.toHaveBeenCalled();
	});

	it("applies onResolved before returning the SDK result", async () => {
		const handlers = registryHandlers(
			new Map([
				[
					"echo_ext",
					async (call) => okResult(call.toolName, "raw", call.toolCallId),
				],
			]),
		);
		const onResolved = vi.fn(async (toolResult: ToolResultMessage) => ({
			...toolResult,
			content: [{ type: "text" as const, text: "rewritten" }],
		}));
		const tools = createCursorOmpExtensionCustomTools(handlers, [echoSpec], onResolved);
		const result = await tools.echo_ext!.execute({ text: "x" } as never, { toolCallId: "tc" });
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			content: [{ type: "text", text: "rewritten" }],
			isError: false,
		});
	});

	it("returns a single mcp invocation per execute (no double side effect)", async () => {
		let hits = 0;
		const handlers = registryHandlers(
			new Map([
				[
					"echo_ext",
					async (call) => {
						hits += 1;
						return okResult(call.toolName, `n=${hits}`, call.toolCallId);
					},
				],
			]),
		);
		const tools = createCursorOmpExtensionCustomTools(handlers, [echoSpec]);
		const a = await tools.echo_ext!.execute({ text: "a" } as never, { toolCallId: "a" });
		const b = await tools.echo_ext!.execute({ text: "b" } as never, { toolCallId: "b" });
		expect(hits).toBe(2);
		expect(a).toEqual(toolResultMessageToSdkCustomToolResult(okResult("echo_ext", "n=1", "a")));
		expect(b).toEqual(toolResultMessageToSdkCustomToolResult(okResult("echo_ext", "n=2", "b")));
	});

	it("surfaces missing mcp handler and tool-not-found without throwing", async () => {
		const missing = createCursorOmpExtensionCustomTools({}, [echoSpec]);
		await expect(missing.echo_ext!.execute({ text: "x" } as never, { toolCallId: "m" })).resolves.toEqual({
			content: [{ type: "text", text: "CursorExecHandlers.mcp is not available" }],
			isError: true,
		});

		const empty = createCursorOmpExtensionCustomTools(registryHandlers(new Map()), [echoSpec]);
		await expect(empty.echo_ext!.execute({ text: "x" } as never, { toolCallId: "n" })).resolves.toEqual({
			content: [{ type: "text", text: expect.stringContaining("not found") }],
			isError: true,
		});
	});

	it("documents host cancel gap: this adapter has no AbortSignal to forward", () => {
		// OMP CursorExecHandlers.executeTool calls tool.execute(..., undefined, ...).
		// SDKCustomToolContext only exposes optional toolCallId. Until the host
		// accepts a signal (or SDK exposes one), bridge cancel parity stays open.
		const tools = createCursorOmpExtensionCustomTools(registryHandlers(new Map()), [echoSpec]);
		expect(typeof tools.echo_ext!.execute).toBe("function");
	});
});

describe("buildCursorOmpExtensionToolSpecs / merge / opt-in", () => {
	it("prefers mcp only when opt-in env is enabled", () => {
		const handlers = { mcp: async () => okResult("x", "y") };
		expect(prefersCursorOmpExtensionCustomTools(handlers, {})).toBe(false);
		expect(prefersCursorOmpExtensionCustomTools(handlers, { [CURSOR_OMP_EXTENSION_CUSTOM_TOOLS_ENV]: "1" })).toBe(true);
		expect(prefersCursorOmpExtensionCustomTools(undefined, { [CURSOR_OMP_EXTENSION_CUSTOM_TOOLS_ENV]: "1" })).toBe(false);
		expect(prefersCursorOmpExtensionCustomTools({}, { [CURSOR_OMP_EXTENSION_CUSTOM_TOOLS_ENV]: "1" })).toBe(false);
	});

	it("skips builtins, reserved SDK names, and respects activeNames", () => {
		const reserved = new Set(listActiveCursorOmpExecCustomToolSdkNames(new Set(["bash", "echo_ext", "shell"])));
		expect(reserved.has("shell")).toBe(true);
		const specs = buildCursorOmpExtensionToolSpecs(
			[
				{ name: "read", description: "r", parameters: {} },
				{ name: "bash", description: "b", parameters: {} },
				{ name: "shell", description: "user shell", parameters: { type: "object", properties: {} } },
				{ name: "echo_ext", description: "e", parameters: { type: "object", properties: {} } },
				{ name: "closed", description: "c", parameters: {} },
			],
			{ activeNames: new Set(["echo_ext", "read", "bash", "shell"]), reservedSdkNames: reserved },
		);
		expect(specs.map((s) => s.name)).toEqual(["echo_ext"]);
		expect(specs[0]?.inputSchema).toMatchObject({ type: "object" });
	});

	it("extension inputSchema matches bridge normalizeMcpInputSchema projection", () => {
		const combinerTool = {
			name: "union_echo",
			description: "Echo mode from a combiner schema",
			parameters: Type.Object({
				mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
			}),
		};
		const active = new Set([combinerTool.name]);
		for (const requiresCursorToolSchemaProjection of [false, true] as const) {
			const bridgeSchema = normalizeMcpInputSchema(combinerTool, { requiresCursorToolSchemaProjection });
			const specs = buildCursorOmpExtensionToolSpecs([combinerTool], {
				activeNames: active,
				requiresCursorToolSchemaProjection,
			});
			expect(specs).toHaveLength(1);
			expect(specs[0]?.inputSchema).toEqual(bridgeSchema);
		}
	});

	it("surface signature changes when tool set or schema changes", () => {
		const a = buildCursorOmpExtensionToolSpecs([{ name: "echo_ext", description: "e", parameters: { type: "object" } }]);
		const b = buildCursorOmpExtensionToolSpecs([{ name: "echo_ext", description: "e2", parameters: { type: "object" } }]);
		const c = buildCursorOmpExtensionToolSpecs([
			{ name: "echo_ext", description: "e", parameters: { type: "object" } },
			{ name: "other", description: "o", parameters: { type: "object" } },
		]);
		expect(buildCursorOmpExtensionToolSurfaceSignature(a)).not.toBe(buildCursorOmpExtensionToolSurfaceSignature(b));
		expect(buildCursorOmpExtensionToolSurfaceSignature(a)).not.toBe(buildCursorOmpExtensionToolSurfaceSignature(c));
		expect(buildCursorOmpExtensionToolSurfaceSignature([])).toBe("omp-mcp:empty");
	});

	it("merge keeps first tool on name collision", () => {
		const a = { shared: { execute: async () => ({ content: [{ type: "text" as const, text: "a" }] }) } };
		const b = {
			shared: { execute: async () => ({ content: [{ type: "text" as const, text: "b" }] }) },
			other: { execute: async () => "o" },
		};
		const merged = mergeCursorOmpCustomTools(a, b)!;
		expect(Object.keys(merged).sort()).toEqual(["other", "shared"]);
		expect(merged.shared).toBe(a.shared);
	});

	it("assigns unique toolCallId when SDK omits id", async () => {
		const seen = new Set<string>();
		const tools = createCursorOmpExtensionCustomTools(
			registryHandlers(
				new Map([
					[
						"echo_ext",
						async (call) => {
							seen.add(call.toolCallId);
							return okResult("echo_ext", "ok", call.toolCallId);
						},
					],
				]),
			),
			[echoSpec],
		);
		await tools.echo_ext!.execute({ text: "a" } as never, {} as never);
		await tools.echo_ext!.execute({ text: "b" } as never, { toolCallId: "  " } as never);
		expect(seen.size).toBe(2);
		for (const id of seen) {
			expect(id.length).toBeGreaterThan(8);
			expect(id).not.toBe("cursor-omp-extension");
		}
	});
});

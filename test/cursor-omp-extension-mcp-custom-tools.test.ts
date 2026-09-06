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

	it("aborts execution before dispatch when signal is already aborted", async () => {
		let invoked = false;
		const controller = new AbortController();
		controller.abort("user cancelled before send");

		const tools = createCursorOmpExtensionCustomTools(
			registryHandlers(
				new Map([
					[
						"echo_ext",
						async () => {
							invoked = true;
							return okResult("echo_ext", "ok");
						},
					],
				]),
			),
			[echoSpec],
			undefined,
			{ signal: controller.signal },
		);

		const result = (await tools.echo_ext!.execute({ text: "hi" } as never, { toolCallId: "call_aborted_pre" } as never)) as {
			isError: boolean;
			content: { type: string; text: string }[];
		};
		expect(invoked).toBe(false);
		expect(result).toMatchObject({
			isError: true,
		});
		expect(result.content?.[0]).toMatchObject({
			type: "text",
		});
		expect(result.content?.[0]?.text).toContain("aborted before start");
		expect(result.content?.[0]?.text).toContain("user cancelled before send");
	});

	it("preserves `this` method receiver on handlers.mcp class instances (with and without signal)", async () => {
		class TestExecHandlers {
			public readonly options = { prefix: "from_options" };

			async mcp(this: TestExecHandlers, call: { name: string; toolCallId: string }, context?: { signal?: AbortSignal }) {
				if (!this || !this.options) {
					throw new TypeError("Cannot read properties of undefined (reading 'options')");
				}
				const signalMark = context?.signal ? "with_signal" : "no_signal";
				return okResult(call.name, `${this.options.prefix}:${signalMark}`, call.toolCallId);
			}
		}

		const handlers = new TestExecHandlers() as unknown as CursorExecHandlers;

		// 1. Without signal
		const toolsNoSignal = createCursorOmpExtensionCustomTools(handlers, [echoSpec]);
		const resNoSignal = (await toolsNoSignal.echo_ext!.execute({ text: "test" } as never, { toolCallId: "call_this_1" } as never)) as {
			isError: boolean;
			content: { type: string; text: string }[];
		};
		expect(resNoSignal).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "from_options:no_signal" }],
		});

		// 2. With signal
		const controller = new AbortController();
		const toolsWithSignal = createCursorOmpExtensionCustomTools(handlers, [echoSpec], undefined, { signal: controller.signal });
		const resWithSignal = (await toolsWithSignal.echo_ext!.execute({ text: "test" } as never, { toolCallId: "call_this_2" } as never)) as {
			isError: boolean;
			content: { type: string; text: string }[];
		};
		expect(resWithSignal).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "from_options:with_signal" }],
		});
	});

	it("cancels an in-flight pending execution mid-flight when signal aborts", async () => {
		const controller = new AbortController();
		let startedResolve: () => void;
		const startedPromise = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const completedCallIds: string[] = [];
		let receivedSignal: AbortSignal | undefined;

		const handlers = {
			async mcp(this: unknown, call: { toolCallId: string; name: string }, context?: { signal?: AbortSignal }) {
				receivedSignal = context?.signal;
				// Signal that execution has entered the working phase and is pending
				startedResolve();

				// Simulate long-running asynchronous work that observes signal and cleans up timer on abort
				return new Promise((resolve, reject) => {
					const signal = context?.signal;
					if (signal?.aborted) {
						reject(new Error(`aborted: ${signal.reason}`));
						return;
					}
					let timer: ReturnType<typeof setTimeout> | undefined;
					const onAbort = () => {
						if (timer !== undefined) clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						reject(new Error(`aborted: ${signal?.reason ?? "operation aborted"}`));
					};
					signal?.addEventListener("abort", onAbort);

					timer = setTimeout(() => {
						signal?.removeEventListener("abort", onAbort);
						completedCallIds.push(call.toolCallId);
						resolve(okResult(call.name, "finished_late", call.toolCallId));
					}, 100);
				});
			},
		} as unknown as CursorExecHandlers;

		const tools = createCursorOmpExtensionCustomTools(
			handlers,
			[echoSpec],
			undefined,
			{ signal: controller.signal },
		);

		// Start execution WITHOUT immediately awaiting it to complete
		const inFlightPromise = tools.echo_ext!.execute({ text: "hi" } as never, { toolCallId: "call_aborted_inflight" } as never);

		// Wait until execution has confirmed entered working phase (pending)
		await startedPromise;
		expect(receivedSignal).toBe(controller.signal);
		expect(completedCallIds).toEqual([]);

		// Abort mid-flight while the same call is pending
		controller.abort("cancelled mid-flight");

		// Await original in-flight call to finish
		const result = (await inFlightPromise) as {
			isError: boolean;
			content: { type: string; text: string }[];
		};

		// Assert that the aborted call observed cancellation
		expect(result).toMatchObject({
			isError: true,
		});
		expect(result.content?.[0]?.text).toContain("aborted: cancelled mid-flight");

		// Sleep past the scheduled work deadline (100ms timer + 50ms buffer) to verify the timer was indeed cleared
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(completedCallIds).toEqual([]);

		// Control test: an uncancelled call on the same handlers completes work normally after timer fires
		const uncancelledController = new AbortController();
		const uncancelledTools = createCursorOmpExtensionCustomTools(
			handlers,
			[echoSpec],
			undefined,
			{ signal: uncancelledController.signal },
		);
		const controlResult = (await uncancelledTools.echo_ext!.execute({ text: "hi" } as never, { toolCallId: "call_control_completed" } as never)) as {
			isError: boolean;
			content: { type: string; text: string }[];
		};
		expect(controlResult).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "finished_late" }],
		});
		// Check that ONLY the control call recorded completed work, not the aborted call
		expect(completedCallIds).toEqual(["call_control_completed"]);
	});

	it("maintains backward compatibility when no signal context is provided", async () => {
		let receivedContext: unknown;
		const handlers = {
			mcp: async (_call: unknown, context?: unknown) => {
				receivedContext = context;
				return okResult("echo_ext", "legacy_ok");
			},
		} as unknown as CursorExecHandlers;

		const tools = createCursorOmpExtensionCustomTools(
			handlers,
			[echoSpec],
		);

		const result = (await tools.echo_ext!.execute({ text: "hi" } as never, {} as never)) as {
			isError: boolean;
			content: { type: string; text: string }[];
		};
		expect(receivedContext).toBeUndefined();
		expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: "legacy_ok" }] });
	});
});

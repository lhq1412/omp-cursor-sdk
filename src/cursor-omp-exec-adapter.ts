import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolContext, SDKCustomToolResult, SDKJsonValue, ToolName } from "@cursor/sdk";
import type { CursorExecHandlers, SimpleStreamOptions, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { omitUndefinedArgs, piGrepSkip, piLimit, piLsPath, piTimeout } from "@oh-my-pi/pi-ai/providers/cursor-pi-args";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { stableNameHash } from "./cursor-pi-tool-bridge-mcp.js";
import { normalizeMcpInputSchema } from "./cursor-pi-tool-bridge-snapshot.js";
import { isExcludedFromCursorBridgeExposure } from "./cursor-tool-presentation-registry.js";
import { isRegisteredCursorNativeToolName } from "./cursor-native-tool-display-state.js";
import {
	asRecord,
	getArray,
	getBoolean,
	getNumber,
	getString,
	stringifyUnknown,
} from "./cursor-record-utils.js";

/** OMP tool names already served by createCursorOmpExecCustomTools (do not dual-expose). */
const OMP_BUILTIN_EXEC_TOOL_NAMES = new Set([
	"read",
	"bash",
	"write",
	"edit",
	"grep",
	"glob",
	"find",
	"ls",
	"delete",
]);

export const CURSOR_OMP_EXEC_DISALLOWED_TOOLS = [
	"read",
	"shell",
	"edit",
	"grep",
	"glob",
	"ls",
	"delete",
] as const satisfies readonly ToolName[];

export const CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES = [
	"read",
	"shell",
	"write",
	"edit",
	"grep",
	"glob",
	"ls",
	"delete",
] as const;

type CursorOmpExecCustomToolName = (typeof CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES)[number];

export function resolveCursorProviderExecHandlers(options?: SimpleStreamOptions): CursorExecHandlers | undefined {
	return options?.cursorExecHandlers ?? options?.execHandlers;
}

export function isCursorOmpExecCustomToolName(name: string): boolean {
	if ((CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES as readonly string[]).includes(name)) return true;
	if (!name.includes("custom-user-tools")) return false;
	const trailing = name.split(/[/:\-.]/).pop() ?? "";
	return (CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES as readonly string[]).includes(trailing);
}

export function isCursorOmpExecToolCall(toolCall: unknown): boolean {
	const record = asRecord(toolCall);
	if (!record) return false;
	const args = asRecord(record.args) ?? asRecord(record.input);
	const provider = getString(record, "providerIdentifier") ?? getString(args, "providerIdentifier") ?? "";
	if (provider.includes("custom-user-tools")) return true;
	const type = getString(record, "type") ?? getString(record, "name") ?? "";
	if (type !== "mcp" && !type.includes("custom-user-tools")) return false;
	const names = [
		getString(record, "name"),
		getString(record, "toolName"),
		getString(args, "toolName"),
		getString(args, "name"),
	];
	return names.some((name) => typeof name === "string" && isCursorOmpExecCustomToolName(name));
}

export function toolResultMessageToSdkCustomToolResult(toolResult: ToolResultMessage): SDKCustomToolResult {
	const content = toolResult.content.map((block) =>
		block.type === "text"
			? { type: "text" as const, text: block.text }
			: { type: "image" as const, data: block.data, mimeType: block.mimeType },
	);
	return {
		content: content.length > 0 ? content : [{ type: "text", text: "" }],
		isError: toolResult.isError === true,
	};
}

const INPUT_SCHEMAS: Record<CursorOmpExecCustomToolName, NonNullable<SDKCustomTool["inputSchema"]>> = {
	read: {
		type: "object",
		properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
		required: ["path"],
		additionalProperties: false,
	},
	shell: {
		type: "object",
		properties: { command: { type: "string" }, timeout: { type: "number" } },
		required: ["command"],
		additionalProperties: false,
	},
	write: {
		type: "object",
		properties: { path: { type: "string" }, content: { type: "string" } },
		required: ["path", "content"],
		additionalProperties: false,
	},
	edit: {
		type: "object",
		properties: {
			path: { type: "string" },
			edits: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					properties: { oldText: { type: "string" }, newText: { type: "string" } },
					required: ["oldText", "newText"],
					additionalProperties: false,
				},
			},
		},
		required: ["path", "edits"],
		additionalProperties: false,
	},
	grep: {
		type: "object",
		properties: {
			pattern: { type: "string" },
			path: { type: "string" },
			glob: { type: "string" },
			ignoreCase: { type: "boolean" },
			literal: { type: "boolean" },
			context: { type: "number" },
			limit: { type: "number" },
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	glob: {
		type: "object",
		properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } },
		required: ["pattern"],
		additionalProperties: false,
	},
	ls: {
		type: "object",
		properties: { path: { type: "string" } },
		additionalProperties: false,
	},
	delete: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	},
};

const CUSTOM_TOOL_OMP_NAMES: { [K in CursorOmpExecCustomToolName]?: string } = {
	read: "read",
	shell: "bash",
	write: "write",
	edit: "edit",
	grep: "grep",
	glob: "glob",
	ls: "read",
};

export type CursorOmpExecResolvedSink = (
	toolResult: ToolResultMessage,
	args: Record<string, unknown>,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

/** Active OMP extension/custom tool exposed to the SDK as a customTool. */
export type CursorOmpExtensionToolSpec = {
	name: string;
	description?: string;
	inputSchema?: NonNullable<SDKCustomTool["inputSchema"]>;
};

export type CursorOmpExtensionCustomToolsOptions = {
	/** CursorMcpCall.providerIdentifier; default `omp`. */
	providerIdentifier?: string;
};
/** Opt-in: extension tools via handlers.mcp customTools (skip loopback bridge). Default off until cancel hard gate closes. */
export const CURSOR_OMP_EXTENSION_CUSTOM_TOOLS_ENV = "PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS";

export function resolveCursorOmpExtensionCustomToolsEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return parseEnvBoolean(env[CURSOR_OMP_EXTENSION_CUSTOM_TOOLS_ENV], false);
}

/** True when mcp exists and PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS is enabled (default off). */
export function prefersCursorOmpExtensionCustomTools(
	handlers?: CursorExecHandlers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return typeof handlers?.mcp === "function" && resolveCursorOmpExtensionCustomToolsEnabled(env);
}

/** SDK customTool names that createCursorOmpExecCustomTools will install for this active set. */
export function listActiveCursorOmpExecCustomToolSdkNames(
	activeToolNames?: ReadonlySet<string>,
): string[] {
	const names: string[] = [];
	for (const name of CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES) {
		const ompName = CUSTOM_TOOL_OMP_NAMES[name];
		if (activeToolNames && ompName !== undefined && !activeToolNames.has(ompName)) continue;
		names.push(name);
	}
	return names;
}

/**
 * Build SDK customTool specs for active non-builtin OMP tools.
 * Schemas reuse the bridge MCP projection helpers without standing up HTTP.
 * `reservedSdkNames` drops extension names that would collide with builtins (no silent dual routing).
 */
export function buildCursorOmpExtensionToolSpecs(
	tools: readonly Pick<Tool, "name" | "description" | "parameters">[] | undefined,
	options?: {
		activeNames?: ReadonlySet<string>;
		reservedSdkNames?: ReadonlySet<string>;
		requiresCursorToolSchemaProjection?: boolean;
	},
): CursorOmpExtensionToolSpec[] {
	if (!tools?.length) return [];
	const active = options?.activeNames;
	const reserved = options?.reservedSdkNames;
	const schemaOptions = {
		requiresCursorToolSchemaProjection: options?.requiresCursorToolSchemaProjection === true,
	};
	const out: CursorOmpExtensionToolSpec[] = [];
	const seen: Record<string, true> = {};
	for (const tool of tools) {
		const name = tool.name;
		if (!name || seen[name]) continue;
		if (active && !active.has(name)) continue;
		if (reserved?.has(name)) continue;
		if (OMP_BUILTIN_EXEC_TOOL_NAMES.has(name)) continue;
		if (isExcludedFromCursorBridgeExposure(name) && isRegisteredCursorNativeToolName(name)) continue;
		seen[name] = true;
		out.push({
			name,
			description: tool.description || `Run OMP tool ${name}`,
			inputSchema: normalizeMcpInputSchema(tool, schemaOptions) as NonNullable<SDKCustomTool["inputSchema"]>,
		});
	}
	return out;
}

/** Pool-key fingerprint of the extension customTools surface (name/description/schema). */
export function buildCursorOmpExtensionToolSurfaceSignature(
	specs: readonly CursorOmpExtensionToolSpec[],
): string {
	if (specs.length === 0) return "omp-mcp:empty";
	const serialized = specs
		.map((tool) =>
			JSON.stringify({
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema ?? null,
			}),
		)
		.sort()
		.join("\0");
	return `omp-mcp:${stableNameHash(serialized)}`;
}

/** First group wins on name collision (pass builtins before extensions). Prefer filtering reserved names at spec build. */
export function mergeCursorOmpCustomTools(
	...groups: Array<Record<string, SDKCustomTool> | undefined>
): Record<string, SDKCustomTool> | undefined {
	const merged: Record<string, SDKCustomTool> = {};
	for (const group of groups) {
		if (!group) continue;
		for (const [name, tool] of Object.entries(group)) {
			if (merged[name]) continue;
			merged[name] = tool;
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}


/**
 * PR0 spike: map active OMP tools onto SDK customTools that execute through
 * `CursorExecHandlers.mcp` (host registry lookup), not the loopback MCP bridge.
 *
 * Cancel: OMP 18.1.11 `executeTool` still passes `undefined` as AbortSignal into
 * `tool.execute`. This path cannot claim cancel-safety until the host does.
 */
export function createCursorOmpExtensionCustomTools(
	handlers: CursorExecHandlers,
	tools: readonly CursorOmpExtensionToolSpec[],
	onResolved?: CursorOmpExecResolvedSink,
	options?: CursorOmpExtensionCustomToolsOptions,
): Record<string, SDKCustomTool> {
	const providerIdentifier = options?.providerIdentifier ?? "omp";
	const out: Record<string, SDKCustomTool> = {};
	for (const tool of tools) {
		const name = tool.name;
		if (!name || out[name]) continue;
		out[name] = {
			...(tool.description !== undefined ? { description: tool.description } : {}),
			...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
			execute: (args, context) =>
				executeCursorOmpExtensionTool(name, args, context, handlers, onResolved, providerIdentifier),
		};
	}
	return out;
}

async function executeCursorOmpExtensionTool(
	toolName: string,
	args: Record<string, SDKJsonValue>,
	context: SDKCustomToolContext,
	handlers: CursorExecHandlers,
	onResolved: CursorOmpExecResolvedSink | undefined,
	providerIdentifier: string,
): Promise<SDKCustomToolResult> {
	const toolCallId = context.toolCallId?.trim() || `cursor-omp-extension-${randomUUID()}`;
	const rawArgs = args as Record<string, unknown>;
	try {
		if (!handlers.mcp) {
			const missing = {
				role: "toolResult" as const,
				toolCallId,
				toolName,
				content: [{ type: "text" as const, text: "CursorExecHandlers.mcp is not available" }],
				isError: true,
				timestamp: Date.now(),
			};
			const resolved = await applyCursorOmpExecResolvedSink(onResolved, missing, rawArgs);
			return toolResultMessageToSdkCustomToolResult(resolved);
		}
		const invoked = await handlers.mcp({
			name: toolName,
			providerIdentifier,
			toolName,
			toolCallId,
			args: rawArgs,
			rawArgs: {},
		});
		const toolResult = unwrapCursorExecHandlerResult(invoked, toolCallId, toolName);
		const resolved = await applyCursorOmpExecResolvedSink(onResolved, toolResult, rawArgs);
		return toolResultMessageToSdkCustomToolResult(resolved);
	} catch (error) {
		const failed = {
			role: "toolResult" as const,
			toolCallId,
			toolName,
			content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
			isError: true,
			timestamp: Date.now(),
		};
		const resolved = await applyCursorOmpExecResolvedSink(onResolved, failed, rawArgs);
		return toolResultMessageToSdkCustomToolResult(resolved);
	}
}


export function createCursorOmpExecCustomTools(
	handlers: CursorExecHandlers,
	activeToolNames?: ReadonlySet<string>,
	onResolved?: CursorOmpExecResolvedSink,
): Record<string, SDKCustomTool> {
	const tools: Record<string, SDKCustomTool> = {};
	for (const name of CURSOR_OMP_EXEC_CUSTOM_TOOL_NAMES) {
		const ompName = CUSTOM_TOOL_OMP_NAMES[name];
		if (activeToolNames && ompName !== undefined && !activeToolNames.has(ompName)) continue;
		tools[name] = {
			inputSchema: INPUT_SCHEMAS[name],
			execute: (args, context) => executeCursorOmpExecTool(name, args, context, handlers, onResolved),
		};
	}
	return tools;
}

async function applyCursorOmpExecResolvedSink(
	onResolved: CursorOmpExecResolvedSink | undefined,
	toolResult: ToolResultMessage,
	args: Record<string, unknown>,
): Promise<ToolResultMessage> {
	if (!onResolved) return toolResult;
	try {
		return (await onResolved(toolResult, args)) ?? toolResult;
	} catch {
		return toolResult;
	}
}

async function executeCursorOmpExecTool(
	name: CursorOmpExecCustomToolName,
	args: Record<string, SDKJsonValue>,
	context: SDKCustomToolContext,
	handlers: CursorExecHandlers,
	onResolved?: CursorOmpExecResolvedSink,
): Promise<SDKCustomToolResult> {
	const toolCallId = context.toolCallId ?? "cursor-omp-exec";
	try {
		const invoked = await invokeCursorOmpExecHandler(name, args, toolCallId, handlers);
		const toolResult = invoked === undefined
			? {
				role: "toolResult" as const,
				toolCallId,
				toolName: name,
				content: [{ type: "text" as const, text: "Tool not available" }],
				isError: true,
				timestamp: Date.now(),
			}
			: unwrapCursorExecHandlerResult(invoked, toolCallId, name);
		const resolvedToolResult = await applyCursorOmpExecResolvedSink(onResolved, toolResult, args);
		return toolResultMessageToSdkCustomToolResult(resolvedToolResult);
	} catch (error) {
		const toolResult = {
			role: "toolResult" as const,
			toolCallId,
			toolName: name,
			content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
			isError: true,
			timestamp: Date.now(),
		};
		const resolvedToolResult = await applyCursorOmpExecResolvedSink(onResolved, toolResult, args);
		return toolResultMessageToSdkCustomToolResult(resolvedToolResult);
	}
}

function legacyArgs<T>(args: object): T {
	return args as T;
}

async function invokeCursorOmpExecHandler(
	name: CursorOmpExecCustomToolName,
	rawArgs: Record<string, unknown>,
	toolCallId: string,
	handlers: CursorExecHandlers,
): Promise<unknown> {
	const path = getString(rawArgs, "path");
	switch (name) {
		case "read": {
			const offset = getNumber(rawArgs, "offset");
			const limit = getNumber(rawArgs, "limit");
			if (handlers.piRead) {
				return handlers.piRead({
					args: { path: path ?? "", ...omitUndefinedArgs({ offset, limit }) },
					toolCallId,
				});
			}
			if (handlers.read) {
				return handlers.read(legacyArgs({ path: path ?? "", toolCallId, ...omitUndefinedArgs({ offset, limit }) }));
			}
			return undefined;
		}
		case "shell": {
			const command = getString(rawArgs, "command") ?? "";
			const timeout = getNumber(rawArgs, "timeout");
			if (handlers.piBash) {
				return handlers.piBash({
					args: { command, ...omitUndefinedArgs({ timeout: piTimeout(timeout) }) },
					toolCallId,
				});
			}
			const args = {
				command,
				...omitUndefinedArgs({ workingDirectory: getString(rawArgs, "workingDirectory"), timeout, toolCallId }),
			};
			if (handlers.shell) return handlers.shell(legacyArgs(args));
			if (handlers.shellStream) {
				return handlers.shellStream(legacyArgs(args), { onStdout() {}, onStderr() {} });
			}
			return undefined;
		}
		case "write": {
			const content = getString(rawArgs, "content") ?? getString(rawArgs, "fileText") ?? "";
			if (handlers.piWrite) {
				return handlers.piWrite({ args: { path: path ?? "", content }, toolCallId });
			}
			if (handlers.write) {
				return handlers.write(legacyArgs({ path: path ?? "", fileText: content, toolCallId }));
			}
			return undefined;
		}
		case "edit": {
			const edits = buildEdits(rawArgs);
			if (!edits || !handlers.piEdit) return undefined;
			return handlers.piEdit({ args: { path: path ?? "", edits }, toolCallId });
		}
		case "grep": {
			const pattern = getString(rawArgs, "pattern") ?? "";
			const glob = getString(rawArgs, "glob");
			const ignoreCase = getBoolean(rawArgs, "ignoreCase") ?? getBoolean(rawArgs, "caseInsensitive");
			if (handlers.piGrep) {
				return handlers.piGrep({
					args: {
						pattern,
						...omitUndefinedArgs({
							path,
							glob,
							ignoreCase,
							literal: getBoolean(rawArgs, "literal"),
							context: getNumber(rawArgs, "context"),
							limit: piLimit(getNumber(rawArgs, "limit") ?? getNumber(rawArgs, "headLimit")),
						}),
					},
					toolCallId,
				});
			}
			if (handlers.grep) {
				return handlers.grep(legacyArgs({
					pattern,
					toolCallId,
					...omitUndefinedArgs({
						path,
						glob,
						caseInsensitive: ignoreCase,
						offset: piGrepSkip(getNumber(rawArgs, "offset")),
					}),
				}));
			}
			return undefined;
		}
		case "glob": {
			if (!handlers.piFind) return undefined;
			return handlers.piFind({
				args: {
					pattern: getString(rawArgs, "pattern") ?? getString(rawArgs, "globPattern") ?? "",
					...omitUndefinedArgs({
						path: path ?? getString(rawArgs, "targetDirectory"),
						limit: piLimit(getNumber(rawArgs, "limit")),
					}),
				},
				toolCallId,
			});
		}
		case "ls": {
			if (handlers.piLs) {
				return handlers.piLs({ args: { path: piLsPath(path) }, toolCallId });
			}
			if (handlers.ls) {
				return handlers.ls(legacyArgs({
					path: path ?? "",
					toolCallId,
					ignore: (getArray(rawArgs, "ignore") ?? []).filter((entry): entry is string => typeof entry === "string"),
				}));
			}
			return undefined;
		}
		case "delete": {
			if (!handlers.delete) return undefined;
			return handlers.delete(legacyArgs({ path: path ?? "", toolCallId }));
		}
	}
}

function buildEdits(rawArgs: Record<string, unknown>): Array<{ oldText: string; newText: string }> | undefined {
	const listed = getArray(rawArgs, "edits")
		?.map(readReplacement)
		.filter((edit): edit is { oldText: string; newText: string } => edit !== undefined);
	if (listed && listed.length > 0) return listed;
	const single = readReplacement(rawArgs);
	return single ? [single] : undefined;
}

function readReplacement(value: unknown): { oldText: string; newText: string } | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const oldText = getString(record, "oldText") ?? getString(record, "old_string");
	const newText = getString(record, "newText") ?? getString(record, "new_string");
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return !!value && typeof value === "object" && (value as ToolResultMessage).role === "toolResult";
}

function unwrapCursorExecHandlerResult(value: unknown, toolCallId: string, toolName: string): ToolResultMessage {
	if (isToolResultMessage(value)) return value;
	const nested = asRecord(value)?.toolResult;
	if (isToolResultMessage(nested)) return nested;
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: stringifyUnknown(value) }],
		isError: false,
		timestamp: Date.now(),
	};
}

import type { Tool } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP, sanitizeSchemaForCursor, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type {
	CursorPiBridgeToolDefinition,
	CursorPiMcpInputSchema,
	CursorPiToolBridgeSnapshot,
	CursorPiToolBridgeSnapshotApi,
	CursorPiToolBridgeSnapshotOptions,
} from "./cursor-pi-tool-bridge-types.js";
import { createMcpToolName, stableNameHash } from "./cursor-pi-tool-bridge-mcp.js";
export {
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_ENV,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-env.js";
import { isRegisteredCursorNativeToolName } from "./cursor-native-tool-display-state.js";
import { isExcludedFromCursorBridgeExposure } from "./cursor-tool-presentation-registry.js";
import { asRecord, stableJson } from "./cursor-record-utils.js";

const EMPTY_MCP_OBJECT_SCHEMA: CursorPiMcpInputSchema = { type: "object", properties: {} };

export type NormalizeMcpInputSchemaOptions = {
	/** When true, reuse OMP Cursor combiner projection before MCP normalization. */
	requiresCursorToolSchemaProjection?: boolean;
};


/** Project a pi ToolInfo-like tool onto MCP inputSchema via OMP wire (+ optional Cursor sanitize) + MCP normalization. */
export function normalizeMcpInputSchema(
	tool: Pick<Tool, "name" | "description" | "parameters">,
	options: NormalizeMcpInputSchemaOptions = {},
): CursorPiMcpInputSchema {
	try {
		let wire: Record<string, unknown> = toolWireSchema(tool);
		if (options.requiresCursorToolSchemaProjection === true) {
			// OMP buildMcpToolDefinitions: toolWireSchema → sanitizeSchemaForCursor when required.
			wire = sanitizeSchemaForCursor(wire);
		}
		const normalized = asRecord(normalizeSchemaForMCP(wire));
		return normalized?.type === "object" ? (normalized as CursorPiMcpInputSchema) : EMPTY_MCP_OBJECT_SCHEMA;
	} catch {
		// Invalid extension schemas must not break bridge snapshot / provider startup.
		return EMPTY_MCP_OBJECT_SCHEMA;
	}
}



const OVERLAPPING_CURSOR_NATIVE_PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);

export function createEmptySnapshot(): CursorPiToolBridgeSnapshot {
	return {
		tools: [],
		mcpToolNameToPiToolName: new Map(),
		piToolNameToMcpToolName: new Map(),
	};
}

function isOverlappingCursorNativePiToolName(toolName: string): boolean {
	return OVERLAPPING_CURSOR_NATIVE_PI_BUILTIN_TOOL_NAMES.has(toolName);
}

export function buildCursorPiToolBridgeSurfaceSignature(snapshot: CursorPiToolBridgeSnapshot): string {
	if (snapshot.tools.length === 0) return "bridge:empty";
	const serializedTools = snapshot.tools
		.map((tool) =>
			stableJson({
				piToolName: tool.piToolName,
				mcpToolName: tool.mcpToolName,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}),
		)
		.sort()
		.join("\0");
	return `bridge:on:${stableNameHash(serializedTools)}`;
}

export function buildCursorPiToolBridgeSnapshot(
	pi: CursorPiToolBridgeSnapshotApi,
	options: CursorPiToolBridgeSnapshotOptions = {},
): CursorPiToolBridgeSnapshot {
	const activeToolNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();
	const usedMcpToolNames = new Set<string>();
	const mcpToolNameToPiToolName = new Map<string, string>();
	const piToolNameToMcpToolName = new Map<string, string>();
	const tools: CursorPiBridgeToolDefinition[] = [];

	const exposeOverlappingBuiltins = options.exposeOverlappingBuiltins === true;
	const schemaOptions: NormalizeMcpInputSchemaOptions = {
		requiresCursorToolSchemaProjection: options.requiresCursorToolSchemaProjection === true,
	};

	for (const tool of allTools) {
		if (!activeToolNames.has(tool.name)) continue;
		if (isExcludedFromCursorBridgeExposure(tool.name) && isRegisteredCursorNativeToolName(tool.name)) continue;
		if (!exposeOverlappingBuiltins && isOverlappingCursorNativePiToolName(tool.name)) continue;

		const mcpToolName = createMcpToolName(tool.name, usedMcpToolNames);
		const description = tool.description || `Run OMP tool ${tool.name}`;
		mcpToolNameToPiToolName.set(mcpToolName, tool.name);
		piToolNameToMcpToolName.set(tool.name, mcpToolName);
		tools.push({
			piToolName: tool.name,
			mcpToolName,
			description,
			promptGuidelines: tool.promptGuidelines,
			inputSchema: normalizeMcpInputSchema(tool, schemaOptions),
			sourceInfo: tool.sourceInfo,
		});
	}

	return { tools, mcpToolNameToPiToolName, piToolNameToMcpToolName };
}

import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { getCursorSessionCwd } from "./cursor-session-scope.js";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	CURSOR_REPLAY_TOOL_NAMES,
	type NativeCursorToolName,
} from "./cursor-native-tool-names.js";
import { isCursorReplayToolName } from "./cursor-tool-presentation-registry.js";
import { createCursorReplayOnlyToolDefinition } from "./cursor-native-tool-display-replay.js";
import { consumeCursorNativeToolDisplay } from "./cursor-native-tool-display-state.js";

/**
 * OMP exposes builtin tool metadata but not executable definitions that an
 * extension can wrap safely. Cursor SDK activity therefore replays through the
 * self-contained neutral `cursor` tool; OMP's read/bash/edit/write definitions
 * remain untouched.
 */

export function wrapNativeCursorTool<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
	getCurrentDefinition: () => ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cursorDisplay = consumeCursorNativeToolDisplay(toolCallId);
			if (cursorDisplay) {
				if (cursorDisplay.isError) {
					const text = cursorDisplay.result.content
						.map((entry) => (entry.type === "text" ? entry.text : undefined))
						.filter((entry): entry is string => Boolean(entry))
						.join("\n");
					throw new Error(text || "Cursor tool replay failed");
				}
				return {
					content: cursorDisplay.result.content,
					details: cursorDisplay.result.details as TDetails,
					terminate: cursorDisplay.terminate ?? true,
				};
			}
			return getCurrentDefinition().execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

export function createNativeCursorToolDefinition(
	toolName: NativeCursorToolName,
	_cwd: string,
): ToolDefinition<TSchema, unknown> {
	if (isCursorReplayToolName(toolName)) {
		return createCursorReplayOnlyToolDefinition(toolName) as ToolDefinition<TSchema, unknown>;
	}
	throw new Error(`Unsupported Cursor native replay tool: ${toolName}`);
}

export function registerNativeCursorTool(
	pi: Pick<ExtensionAPI, "registerTool">,
	toolName: NativeCursorToolName,
): void {
	const definition = createNativeCursorToolDefinition(toolName, getCursorSessionCwd());
	pi.registerTool(wrapNativeCursorTool(definition, () => createNativeCursorToolDefinition(toolName, getCursorSessionCwd())));
}

export { CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES, CURSOR_REPLAY_TOOL_NAMES };

import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	isCursorReplayToolName,
} from "./cursor-tool-presentation-registry.js";
import { isNativeCursorToolName } from "./cursor-native-tool-names.js";
import type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
	terminate?: boolean;
	/** SDK/display identity retained when OMP executes the neutral replay tool. */
	sourceToolName?: string;
}

export const NATIVE_CURSOR_TOOL_DISPLAY_ENV = "PI_CURSOR_NATIVE_TOOL_DISPLAY";
export const NATIVE_CURSOR_TOOL_REGISTRATION_ENV = "PI_CURSOR_REGISTER_NATIVE_TOOLS";

export const registeredNativeToolNames = new Set<string>();
export const skippedNativeToolNames = new Set<string>();
export const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();

let nativeToolDisplayRuntimeRequested = false;

export function readBooleanEnv(name: string, env: Record<string, string | undefined> = process.env): boolean | undefined {
	return parseOptionalEnvBoolean(env[name]);
}

export function isCursorNativeToolDisplayRequested(mode?: string): boolean {
	const override = readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV);
	if (override !== undefined) return override;
	if (mode) return mode === "tui" || mode === "json" || mode === "rpc";
	return process.stdout.isTTY === true;
}

export function isCursorNativeToolRegistrationRequested(mode?: string): boolean {
	return mode !== "print" && readBooleanEnv(NATIVE_CURSOR_TOOL_REGISTRATION_ENV) !== false && isCursorNativeToolDisplayRequested(mode);
}

export function setCursorNativeToolDisplayRuntimeRequested(requested: boolean): void {
	nativeToolDisplayRuntimeRequested = requested;
}

export function isCursorNativeToolDisplayEnabled(): boolean {
	return registeredNativeToolNames.size > 0;
}

export function isCursorNativeToolDisplayRuntimeEnabled(): boolean {
	return nativeToolDisplayRuntimeRequested && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== false && registeredNativeToolNames.size > 0;
}

/**
 * Resolves an SDK display name to the extension tool that can replay it.
 * OMP registers one neutral `cursor` tool rather than shadowing host builtins.
 */
export function resolveRegisteredCursorNativeToolName(toolName: string): string | undefined {
	if (registeredNativeToolNames.has(toolName)) return toolName;
	if (
		registeredNativeToolNames.has(CURSOR_REPLAY_ACTIVITY_TOOL_NAME) &&
		isNativeCursorToolName(toolName) &&
		!isCursorReplayToolName(toolName)
	) {
		return CURSOR_REPLAY_ACTIVITY_TOOL_NAME;
	}
	return undefined;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return resolveRegisteredCursorNativeToolName(toolName) !== undefined;
}

export function isRegisteredCursorNativeToolName(toolName: string): boolean {
	return registeredNativeToolNames.has(toolName);
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem): boolean {
	if (!canRenderCursorToolNatively(item.toolName)) return false;
	nativeToolResults.set(item.id, item);
	return true;
}

export function deleteCursorNativeToolDisplay(id: string): void {
	nativeToolResults.delete(id);
}

export function consumeCursorNativeToolDisplay(id: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) nativeToolResults.delete(id);
	return item;
}

export function isCursorReplayToolCallId(toolCallId: string): boolean {
	return toolCallId.startsWith("cursor-replay-");
}

export function isCursorFileMutationToolName(toolName: string): toolName is "edit" | "write" {
	return toolName === "edit" || toolName === "write";
}

export const __testUtils = {
	nativeToolResultCount: () => nativeToolResults.size,
	registerNativeToolNameForTests(toolName: string): void {
		nativeToolDisplayRuntimeRequested = true;
		registeredNativeToolNames.add(toolName);
	},
	reset(): void {
		nativeToolDisplayRuntimeRequested = false;
		registeredNativeToolNames.clear();
		skippedNativeToolNames.clear();
		nativeToolResults.clear();
	},
};

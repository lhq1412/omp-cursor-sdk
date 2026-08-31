import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { arePiToolsDisabled } from "./cursor-active-tools.js";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	isNativeCursorToolName,
	NATIVE_CURSOR_TOOL_NAMES,
	type NativeCursorToolName,
} from "./cursor-native-tool-names.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import {
	isCursorNativeToolDisplayRequested,
	isCursorNativeToolRegistrationRequested,
	NATIVE_CURSOR_TOOL_DISPLAY_ENV,
	readBooleanEnv,
	registeredNativeToolNames,
	setCursorNativeToolDisplayRuntimeRequested,
	skippedNativeToolNames,
} from "./cursor-native-tool-display-state.js";
import { isCursorReplayToolName } from "./cursor-tool-presentation-registry.js";
import { registerNativeCursorTool } from "./cursor-native-tool-display-tools.js";

export const CURSOR_CORE_PI_REPLAY_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const CORE_PI_TOOL_NAMES = new Set<string>(CURSOR_CORE_PI_REPLAY_TOOL_NAMES);

function isCursorCorePiReplayToolName(toolName: string): toolName is (typeof CURSOR_CORE_PI_REPLAY_TOOL_NAMES)[number] {
	return CORE_PI_TOOL_NAMES.has(toolName);
}

type CursorNativeToolActivationApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
type CursorNativeToolRegistryApi = CursorNativeToolActivationApi & Pick<ExtensionAPI, "getAllTools" | "registerTool">;

export interface CursorNativeToolDisplayExtensionApi extends CursorNativeToolRegistryApi, CursorModelLifecycleExtensionApi {}

function hasNonBuiltinTool(pi: Pick<ExtensionAPI, "getAllTools">, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

type NativeRegistrationContext = Pick<ExtensionContext, "mode" | "model"> & {
	ui: Pick<ExtensionContext["ui"], "notify">;
};

async function registerNativeCursorToolsFromSet(
	pi: CursorNativeToolRegistryApi,
	toolNames: readonly NativeCursorToolName[],
): Promise<NativeCursorToolName[]> {
	const newlySkippedToolNames: NativeCursorToolName[] = [];
	for (const toolName of toolNames) {
		if (registeredNativeToolNames.has(toolName) || skippedNativeToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			skippedNativeToolNames.add(toolName);
			newlySkippedToolNames.push(toolName);
			continue;
		}
		registerNativeCursorTool(pi, toolName);
		registeredNativeToolNames.add(toolName);
	}
	return newlySkippedToolNames;
}

function notifySkippedNativeCursorToolsIfNeeded(ctx: NativeRegistrationContext, skippedToolNames: readonly NativeCursorToolName[]): void {
	if (skippedToolNames.length === 0 || readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== true) return;
	ctx.ui.notify(
		`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
		"warning",
	);
}

function hasAttemptedNativeCursorToolRegistration(): boolean {
	return registeredNativeToolNames.size > 0 || skippedNativeToolNames.size > 0;
}

function removeRegisteredNonCoreNativeCursorTools(pi: CursorNativeToolActivationApi): void {
	if (registeredNativeToolNames.size === 0) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	for (const toolName of registeredNativeToolNames) {
		if (isCursorCorePiReplayToolName(toolName)) continue;
		if (!activeToolNames.delete(toolName)) continue;
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

export function syncRegisteredNativeCursorToolsForModel(
	pi: CursorNativeToolActivationApi,
	model: ExtensionContext["model"],
): void {
	if (registeredNativeToolNames.size === 0) return;
	if (!isCursorModel(model)) {
		removeRegisteredNonCoreNativeCursorTools(pi);
		return;
	}
	if (arePiToolsDisabled(pi)) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	for (const toolName of registeredNativeToolNames) {
		if (isCursorReplayToolName(toolName) && !CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES.some((activeReplayToolName) => activeReplayToolName === toolName)) continue;
		if (activeToolNames.has(toolName)) continue;
		activeToolNames.add(toolName);
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

let nativeCursorToolRegistrationPromise: Promise<NativeCursorToolName[]> | undefined;

async function ensureNativeCursorToolsRegisteredForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext): Promise<void> {
	if (!isCursorModel(ctx.model) || hasAttemptedNativeCursorToolRegistration()) return;

	// OMP port: builtin shadowing (read/bash/edit/write/grep/find/ls) is not
	// portable (no builtin definition surface); register only the
	// self-contained replay tool. Share an in-flight registration so overlapping
	// lifecycle hooks cannot double-register it.
	const inFlightRegistration = nativeCursorToolRegistrationPromise;
	if (inFlightRegistration) {
		await inFlightRegistration;
		return;
	}
	const registration = registerNativeCursorToolsFromSet(
		pi,
		NATIVE_CURSOR_TOOL_NAMES.filter(isCursorReplayToolName),
	);
	nativeCursorToolRegistrationPromise = registration;
	try {
		const skippedToolNames = await registration;
		notifySkippedNativeCursorToolsIfNeeded(ctx, skippedToolNames);
	} finally {
		if (nativeCursorToolRegistrationPromise === registration) {
			nativeCursorToolRegistrationPromise = undefined;
		}
	}
}

async function ensureThenSyncNativeCursorToolsForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext): Promise<void> {
	const requested = isCursorNativeToolRegistrationRequested(ctx.mode);
	setCursorNativeToolDisplayRuntimeRequested(requested);
	if (!requested) {
		removeRegisteredNonCoreNativeCursorTools(pi);
		return;
	}
	await ensureNativeCursorToolsRegisteredForModel(pi, ctx);
	syncRegisteredNativeCursorToolsForModel(pi, ctx.model);
}

export function registerCursorNativeToolDisplay(pi: CursorNativeToolDisplayExtensionApi): void {
	registerCursorModelLifecycle(pi, async (ctx) => {
		await ensureThenSyncNativeCursorToolsForModel(pi, ctx);
	});
}

export { isNativeCursorToolName, isCursorNativeToolDisplayRequested };

import { isCursorModel } from "./cursor-model.js";
import {
	registerCursorModelLifecycle,
	type CursorModelLifecycleContext,
	type CursorModelLifecycleExtensionApi,
} from "./cursor-model-lifecycle.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";
import { prewarmCursorSdkRuntime } from "./cursor-sdk-runtime.js";

export function scheduleCursorSdkRuntimePrewarm(ctx: CursorModelLifecycleContext): void {
	if (!isCursorModel(ctx.model)) return;
	try {
		if (resolveEffectiveCursorConfigForContext(ctx).runtime.value !== "local") return;
	} catch {
		return;
	}
	void prewarmCursorSdkRuntime().catch(() => undefined);
}

export function registerCursorSdkRuntimePrewarm(pi: CursorModelLifecycleExtensionApi): void {
	registerCursorModelLifecycle(pi, {
		sessionStart: (_event, ctx) => {
			scheduleCursorSdkRuntimePrewarm(ctx);
		},
		beforeAgentStart: (_event, ctx) => {
			scheduleCursorSdkRuntimePrewarm(ctx);
		},
	});
}

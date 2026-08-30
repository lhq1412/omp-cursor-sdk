import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";
import { resolveCursorFacingSystemPromptParts } from "./cursor-agents-context.js";

export type CursorAgentsContextExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	registerCursorModelLifecycle(pi, {
		beforeAgentStart: (event, ctx) => {
			if (!isCursorModel(ctx.model)) return undefined;
			const runtime = resolveEffectiveCursorConfigForContext(ctx).runtime.value;
			const resolved = resolveCursorFacingSystemPromptParts(
				event.systemPrompt,
				ctx.model,
				undefined,
				undefined,
				runtime,
			);
			if (resolved === event.systemPrompt) return undefined;
			return { systemPrompt: resolved };
		},
	});
}

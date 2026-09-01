import type {
	ExtensionHandler,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionTreeEvent,
} from "@oh-my-pi/pi-coding-agent";
import { clearCursorSdkHttp1 } from "./cursor-http1.js";
import { onCursorSessionScopeKeyChange } from "./cursor-session-scope.js";
import {
	disposeSessionCursorAgent,
	disposeSessionCursorAgentForShutdown,
	invalidateSessionAgent,
	resetSessionCursorAgent,
} from "./cursor-session-agent.js";

export interface CursorSessionAgentLifecycleExtensionApi {
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
}

export function registerCursorSessionAgentLifecycle(pi: CursorSessionAgentLifecycleExtensionApi): void {
	onCursorSessionScopeKeyChange(async (previousScopeKey) => {
		await disposeSessionCursorAgent(previousScopeKey);
	});
	pi.on("session_shutdown", async () => {
		// OMP gives shutdown handlers two seconds. Detach immediately and bound
		// best-effort SDK cleanup so a stuck asyncDispose cannot delay session exit.
		clearCursorSdkHttp1();
		await disposeSessionCursorAgentForShutdown();
	});
	pi.on("session_compact", () => {
		invalidateSessionAgent();
	});
	pi.on("session_before_tree", () => {
		invalidateSessionAgent();
	});
	pi.on("session_tree", async () => {
		await resetSessionCursorAgent();
	});
}

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { CURSOR_HTTP1_ENV } from "../src/cursor-config.js";
import {
	__testUtils as cursorStateTestUtils,
	registerCursorRuntimeControls,
} from "../src/cursor-state.js";
import {
	__testUtils as cursorSessionScopeTestUtils,
	registerCursorSessionScope,
} from "../src/cursor-session-scope.js";
import { registerCursorSdkRuntimePrewarm } from "../src/cursor-sdk-runtime-prewarm.js";
import { prewarmCursorSdkRuntime } from "../src/cursor-sdk-runtime.js";
import { createExtensionTestContext, createPiHarness, makeModel } from "./helpers/pi-harness.js";

vi.mock("../src/cursor-sdk-runtime.js", () => ({
	prewarmCursorSdkRuntime: vi.fn().mockResolvedValue(undefined),
}));

const RUNTIME_ENV_NAMES = [
	"PI_CURSOR_RUNTIME",
	"PI_CURSOR_CLOUD_CONTEXT",
	"PI_CURSOR_CLOUD_AUTO_CREATE_PR",
	"PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST",
	"PI_CURSOR_CLOUD_ACK",
	CURSOR_HTTP1_ENV,
] as const;

function runtimeEntry(runtime: "local" | "cloud"): SessionEntry {
	return {
		type: "custom",
		id: `runtime-${runtime}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: cursorStateTestUtils.RUNTIME_ENTRY_TYPE,
		data: { runtime, cloudAcknowledged: runtime === "cloud" },
	};
}

describe("cursor-sdk runtime prewarm registration order", () => {
	const previousEnv = Object.fromEntries(RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]));
	const previousAgentDir = getAgentDir();
	let agentDir: string | undefined;

	beforeEach(() => {
		cursorSessionScopeTestUtils.reset();
		cursorStateTestUtils.resetCursorModeStateForTests();
		vi.mocked(prewarmCursorSdkRuntime).mockClear();
		for (const name of RUNTIME_ENV_NAMES) delete process.env[name];
		agentDir = mkdtempSync(join(tmpdir(), "cursor-sdk-prewarm-order-"));
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		setAgentDir(agentDir);
	});

	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
		cursorStateTestUtils.resetCursorModeStateForTests();
		setAgentDir(previousAgentDir);
		for (const name of RUNTIME_ENV_NAMES) {
			if (previousEnv[name] === undefined) delete process.env[name];
			else process.env[name] = previousEnv[name];
		}
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	});

	function registerInProductionOrder(pi: ReturnType<typeof createPiHarness>): void {
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
		registerCursorSdkRuntimePrewarm(pi);
	}

	async function startSession(branch: SessionEntry[]): Promise<ExtensionContext> {
		const pi = createPiHarness();
		registerInProductionOrder(pi);
		const ctx = createExtensionTestContext({
			cwd: "/tmp/project",
			model: makeModel("composer-2.5"),
			sessionManager: {
				getBranch: () => branch,
			},
		});
		await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
		return ctx;
	}

	it("does not prewarm after restoring a persisted cloud session", async () => {
		await startSession([runtimeEntry("cloud")]);
		expect(prewarmCursorSdkRuntime).not.toHaveBeenCalled();
	});

	it("prewarms local cursor-sdk sessions after runtime restore", async () => {
		await startSession([runtimeEntry("local")]);
		expect(prewarmCursorSdkRuntime).toHaveBeenCalledOnce();
	});
});

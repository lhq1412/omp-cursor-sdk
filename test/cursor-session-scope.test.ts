import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__testUtils as cursorSessionScopeTestUtils,
	getCursorSessionCwd,
	getCursorSessionName,
	getCursorSessionProjectTrusted,
	MAX_CURSOR_SESSION_NAME_LENGTH,
	registerCursorSessionScope,
} from "../src/cursor-session-scope.js";
import { createEventHarness } from "./helpers/pi-harness.js";

describe("cursor-session-scope cwd", () => {
	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
	});

	it("falls back to process.cwd() before session_start", () => {
		expect(getCursorSessionCwd()).toBe(process.cwd());
	});

	it("syncs cwd from session_start", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionScope(pi);
			await pi.runSessionStart({ cwd: sessionDir });

			expect(getCursorSessionCwd()).toBe(sessionDir);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("syncs project trust from OMP's extension-context predicate", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-session-trust-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionScope(pi);

			await pi.runSessionStart({ cwd, isProjectTrusted: () => false });
			expect(getCursorSessionProjectTrusted()).toBe(false);

			await pi.runSessionStart({ cwd, isProjectTrusted: () => true });
			expect(getCursorSessionProjectTrusted()).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("syncs the normalized session name from session_start", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);

		await pi.runSessionStart({ sessionManager: { getSessionName: vi.fn(() => "  Cloud handoff  ") } });

		expect(getCursorSessionName()).toBe("Cloud handoff");
	});

	it("does not update the session name after session_start (OMP has no session_info_changed event)", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);
		await pi.runSessionStart({ sessionManager: { getSessionName: vi.fn(() => "Initial") } });

		await pi.invokeEvent("session_info_changed", {
			type: "session_info_changed",
			name: "  Renamed\t",
		});
		expect(getCursorSessionName()).toBe("Initial");
	});

	it("bounds session names before exposing them to provider callers", async () => {
		const pi = createEventHarness();
		registerCursorSessionScope(pi);
		await pi.runSessionStart({
			sessionManager: { getSessionName: vi.fn(() => "x".repeat(MAX_CURSOR_SESSION_NAME_LENGTH + 20)) },
		});

		expect(MAX_CURSOR_SESSION_NAME_LENGTH).toBe(100);
		expect(getCursorSessionName()).toHaveLength(MAX_CURSOR_SESSION_NAME_LENGTH);
		expect(getCursorSessionName()?.endsWith("…")).toBe(true);
	});

	it("updates cwd on subsequent session_start events", async () => {
		const firstDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-a-"));
		const secondDir = mkdtempSync(join(tmpdir(), "pi-cursor-session-cwd-b-"));
		try {
			const pi = createEventHarness();
			registerCursorSessionScope(pi);

			await pi.runSessionStart({ cwd: firstDir });
			expect(getCursorSessionCwd()).toBe(firstDir);

			await pi.runSessionStart({ cwd: secondDir });
			expect(getCursorSessionCwd()).toBe(secondDir);
		} finally {
			rmSync(firstDir, { recursive: true, force: true });
			rmSync(secondDir, { recursive: true, force: true });
		}
	});
});

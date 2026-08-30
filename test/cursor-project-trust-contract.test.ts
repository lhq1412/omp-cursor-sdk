import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { resolveCursorProviderTurnConfig } from "../src/cursor-provider-turn-prepare.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";

describe("OMP project trust contract", () => {
	let runRoot: string;
	let projectDir: string;

	beforeEach(async () => {
		await resetCursorProviderTestState();
		runRoot = mkdtempSync(join(tmpdir(), "omp-cursor-project-trust-"));
		projectDir = join(runRoot, "project");
		mkdirSync(join(projectDir, ".omp"), { recursive: true });
	});

	afterEach(() => {
		rmSync(runRoot, { recursive: true, force: true });
		cursorSessionScopeTestUtils.reset();
	});

	it("pins the installed OMP 18 extension context to its always-trusted project contract", () => {
		const types = readFileSync(
			resolve("node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts"),
			"utf8",
		);
		const runner = readFileSync(
			resolve("node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts"),
			"utf8",
		);

		expect(types).toMatch(/isProjectTrusted\(\): boolean/);
		expect(runner).toMatch(/isProjectTrusted:\s*\(\)\s*=>\s*true/);
		expect(runner).not.toContain('emit("project_trust"');
	});

	it("loads trusted project runtime config but never accepts project-local cloud acknowledgement", () => {
		writeFileSync(
			join(projectDir, ".omp", "cursor-sdk.json"),
			JSON.stringify({ runtime: "cloud", cloud: { acknowledged: true } }),
		);
		cursorSessionScopeTestUtils.set(projectDir, join(runRoot, "session.jsonl"), "contract-session", true);

		const config = resolveCursorProviderTurnConfig(projectDir);

		expect(config.runtime).toMatchObject({ value: "cloud", source: "project", trustLevel: "trusted-project" });
		expect(config.cloud.acknowledged).toMatchObject({ value: false, source: "builtin" });
	});

	it("fails closed on project config when an embedding reports the project untrusted", () => {
		writeFileSync(
			join(projectDir, ".omp", "cursor-sdk.json"),
			JSON.stringify({ runtime: "cloud" }),
		);
		cursorSessionScopeTestUtils.set(projectDir, join(runRoot, "session.jsonl"), "contract-session", false);

		const config = resolveCursorProviderTurnConfig(projectDir);

		expect(config.runtime).toMatchObject({ value: "local", source: "builtin" });
	});

	it("fails cloud preflight before SDK create or send when project acknowledgement is the only acknowledgement", async () => {
		writeFileSync(
			join(projectDir, ".omp", "cursor-sdk.json"),
			JSON.stringify({ runtime: "cloud", cloud: { acknowledged: true } }),
		);
		cursorSessionScopeTestUtils.set(projectDir, join(runRoot, "session.jsonl"), "contract-session", true);
		const send = vi.fn();
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel("composer-2.5"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("Cursor cloud runtime requires first-use acknowledgement");
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});

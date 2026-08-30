import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createCursorSdkApiKeyLogin,
	getCursorSdkProviderApiKeyConfig,
	resolveCursorApiKey,
	resolveCursorRuntimeApiKey,
} from "../src/cursor-api-key.js";

describe("cursor-api-key helpers", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		process.argv = ["node", "vitest"];
	});

	afterEach(() => {
		process.env = originalEnv;
		process.argv = originalArgv;
	});

	it.each(["CURSOR_API_KEY", "$CURSOR_API_KEY", "${CURSOR_API_KEY}"])(
		"resolves placeholder %s through env only",
		(placeholder) => {
			expect(resolveCursorApiKey(placeholder)).toBeUndefined();
			process.env.CURSOR_API_KEY = "env-key-123";
			expect(resolveCursorApiKey(placeholder)).toBe("env-key-123");
		},
	);

	it("ignores every process argv form and resolves the runtime key from env", async () => {
		process.argv = [
			"node", "omp", "--model", "anthropic/first", "--api-key", "first-key",
			"--MODEL", "cursor-sdk/case", "--API-KEY", "case-key",
			"--model=cursor-sdk/unsupported", "--api-key=equals-key",
			"--models", "cursor-sdk/list-like", "--provider", "cursor-sdk",
			"--model", "cursor-sdk/final", "--api-key", "last-key",
		];
		expect(await resolveCursorRuntimeApiKey()).toBeUndefined();

		process.env.CURSOR_API_KEY = "env-key-123";
		expect(await resolveCursorRuntimeApiKey()).toBe("env-key-123");
	});

	it("configures OMP's provider key only when CURSOR_API_KEY exists", () => {
		expect(getCursorSdkProviderApiKeyConfig()).toBeUndefined();
		process.env.CURSOR_API_KEY = "env-key-123";
		expect(getCursorSdkProviderApiKeyConfig()).toBe("CURSOR_API_KEY");
	});

	it("registers a login flow that stores a trimmed Cursor SDK API key", async () => {
		const login = createCursorSdkApiKeyLogin();
		const onPrompt = async () => "  login-key-123  ";

		expect(login.name).toBe("Cursor SDK API key");
		await expect(login.login({ onAuth: () => {}, onPrompt })).resolves.toBe("login-key-123");
	});

	it("rejects an empty login value", async () => {
		const login = createCursorSdkApiKeyLogin();
		await expect(login.login({ onAuth: () => {}, onPrompt: async () => "  " })).rejects.toThrow(
			"A Cursor SDK API key is required.",
		);
	});
});

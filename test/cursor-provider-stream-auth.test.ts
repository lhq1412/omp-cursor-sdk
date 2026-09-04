import { AuthenticationError } from "@cursor/sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	resetCursorProviderTestState,
	mockedCreate,
	mockedMessagesList,
	makeModel,
	makeContext,
	collectEvents,
	getErrorEvent,
	getDoneEvent,
	getEventsOfType,
	hasEventType,
	mockCreatedAgent,
	asMockSdkAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { __testUtils as cursorSdkProcessGuardTestUtils } from "../src/cursor-sdk-process-error-guard.js";
import { streamCursor } from "../src/cursor-provider.js";
import { MISSING_CURSOR_API_KEY_MESSAGE } from "../src/cursor-provider-errors.js";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeUnauthenticatedConnectError(): Error & { rawMessage: string; code: number } {
	const error = new Error("[unauthenticated] Error") as Error & { rawMessage: string; code: number };
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 16;
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js:53:19\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

describe("streamCursor auth and abort", () => {
	beforeEach(resetCursorProviderTestState);

	it("emits start before abort when the signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal });
		const events = await collectEvents(stream);
		const error = getErrorEvent(events);

		expect(hasEventType(events, "start")).toBe(true);
		expect(error.reason).toBe("aborted");
		expect(events.findIndex((event) => event.type === "start")).toBeLessThan(
			events.findIndex((event) => event.type === "error"),
		);
	});

	it("aborts after agent creation without sending a prompt when already cancelled", async () => {
		const controller = new AbortController();
		const mockDispose = vi.fn().mockResolvedValue(undefined);
		const mockSend = vi.fn();
		mockedCreate.mockImplementation(async () => {
			controller.abort();
			return asMockSdkAgent({
				send: mockSend,
				[Symbol.asyncDispose]: mockDispose,
			});
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key", signal: controller.signal });
		const events = await collectEvents(stream);
		const error = getErrorEvent(events);

		expect(error.reason).toBe("aborted");
		expect(error.error.stopReason).toBe("aborted");
		expect(error.error.errorMessage).toBe("Cancelled: prompt interrupted.");
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it("emits actionable error when no API key", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		delete process.env.CURSOR_API_KEY;
		try {
			const stream = streamCursor(makeModel(), makeContext(), { apiKey: undefined });
			const events = await collectEvents(stream);

			const error = getErrorEvent(events);
			expect(error.error.errorMessage).toContain("/login");
			expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
			expect(error.error.errorMessage).toContain("--api-key");
		} finally {
			if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = originalKey;
		}
	});

	it.each(["CURSOR_API_KEY", "$CURSOR_API_KEY", "${CURSOR_API_KEY}", "pi-cursor-sdk-cursor-api-key-placeholder"])(
		"treats unresolved %s provider placeholders as a missing API key",
		async (placeholder) => {
			const originalKey = process.env.CURSOR_API_KEY;
			delete process.env.CURSOR_API_KEY;
			try {
				const stream = streamCursor(makeModel(), makeContext(), { apiKey: placeholder });
				const events = await collectEvents(stream);

				const error = getErrorEvent(events);
				expect(error).toBeDefined();
				expect(error.error.errorMessage).toBe(MISSING_CURSOR_API_KEY_MESSAGE);
				expect(mockedCreate).not.toHaveBeenCalled();
			} finally {
				if (originalKey === undefined) {
					delete process.env.CURSOR_API_KEY;
				} else {
					process.env.CURSOR_API_KEY = originalKey;
				}
			}
		},
	);

	it.each(["CURSOR_API_KEY", "$CURSOR_API_KEY", "${CURSOR_API_KEY}"])(
		"resolves %s provider placeholders through the env var when present",
		async (placeholder) => {
			const originalKey = process.env.CURSOR_API_KEY;
			process.env.CURSOR_API_KEY = "env-key-123";
			try {
				const mockSend = vi.fn().mockResolvedValue({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
				mockCreatedAgent({
					send: mockSend,
					[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
				});

				const stream = streamCursor(makeModel(), makeContext(), { apiKey: placeholder });
				await collectEvents(stream);

				expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "env-key-123" }));
			} finally {
				if (originalKey === undefined) {
					delete process.env.CURSOR_API_KEY;
				} else {
					process.env.CURSOR_API_KEY = originalKey;
				}
			}
		},
	);

	it("never reinterprets the removed internal placeholder as an environment credential", async () => {
		const originalKey = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "env-key-123";
		try {
			const events = await collectEvents(streamCursor(makeModel(), makeContext(), {
				apiKey: "pi-cursor-sdk-cursor-api-key-placeholder",
			}));

			expect(getErrorEvent(events).error.errorMessage).toBe(MISSING_CURSOR_API_KEY_MESSAGE);
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = originalKey;
		}
	});

	it("turns generic Cursor SDK failures into actionable setup errors", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Error"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		expect(error.error.errorMessage).toContain("Cursor SDK request failed");
		expect(error.error.errorMessage).toContain("/login");
		expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
		expect(error.error.errorMessage).toContain("--api-key");
		expect(error.error.errorMessage).not.toBe("Error");
	});

	it("labels likely auth failures without leaking the supplied API key", async () => {
		mockedCreate.mockRejectedValueOnce(new Error("Unauthorized Bearer super-secret-key-12345"));

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		const message = error.error.errorMessage;
		expect(message).toContain("invalid or unauthorized");
		expect(message).toContain("/login");
		expect(message).toContain("CURSOR_API_KEY");
		expect(message).not.toContain("super-secret-key-12345");
	});

	it("labels cloud Agent.create auth failures as Cloud API auth before prepare completes", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		mockedCreate.mockRejectedValueOnce(
			new AuthenticationError("Invalid User API Key at https://alice:super-secret-key-12345@api.cursor.com"),
		);

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "super-secret-key-12345" });
		const events = await collectEvents(stream);

		const message = getErrorEvent(events).error.errorMessage;
		expect(message).toContain("Cloud API authentication");
		expect(message).toContain("user API key");
		expect(message).toContain("service account API key");
		expect(message).toContain("Team Admin API keys are not supported");
		expect(message).not.toContain("super-secret-key-12345");
	});

	it("labels unauthenticated ConnectError from run.wait as an auth failure", async () => {
		const mockSend = vi.fn().mockResolvedValue(
			asMockCursorRun({
				id: "run-auth-expired",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockRejectedValue(makeUnauthenticatedConnectError()),
			}),
		);
		mockCreatedAgent({ send: mockSend });

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);

		const error = getErrorEvent(events);
		expect(error.reason).toBe("error");
		expect(error.error.errorMessage).toContain("invalid or unauthorized");
		expect(error.error.errorMessage).toContain("/login");
		expect(error.error.errorMessage).toContain("CURSOR_API_KEY");
	});

	it("suppresses duplicate process-level unauthenticated ConnectError during an active provider turn", async () => {
		const connectError = makeUnauthenticatedConnectError();
		let processListenerCalled = false;
		const processListener = () => {
			processListenerCalled = true;
		};
		process.once("uncaughtException", processListener);
		const mockSend = vi.fn().mockResolvedValue(
			asMockCursorRun({
				id: "run-auth-expired",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockImplementation(async () => {
					process.emit("uncaughtException", connectError, "uncaughtException");
					throw connectError;
				}),
			}),
		);
		mockCreatedAgent({ send: mockSend });

		try {
			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);

			const errors = getEventsOfType(events, "error");
			expect(errors).toHaveLength(1);
			expect(errors[0].error.errorMessage).toContain("invalid or unauthorized");
			expect(processListenerCalled).toBe(false);
			expect(cursorSdkProcessGuardTestUtils.activeProviderTurnCount()).toBe(0);
		} finally {
			process.removeListener("uncaughtException", processListener);
		}
	});

	it("does not list messages before sends while the local watermark is healthy", async () => {
		let sendCount = 0;
		const mockSend = vi.fn().mockImplementation(async () => {
			expect(mockedMessagesList).toHaveBeenCalledTimes(sendCount);
			sendCount++;
			return asMockCursorRun({
				id: `run-${sendCount}`,
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockResolvedValue({ id: `run-${sendCount}`, status: "finished", result: `turn-${sendCount}` }),
			});
		});
		mockCreatedAgent({ send: mockSend });
		const firstContext = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel("composer-2"), firstContext, { apiKey: "test-key" }));
		expect(mockedMessagesList).toHaveBeenCalledTimes(1);

		const secondContext = makeContext([
			...firstContext.messages,
			getDoneEvent(firstEvents).message,
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		await collectEvents(streamCursor(makeModel("composer-2"), secondContext, { apiKey: "test-key" }));

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockedMessagesList).toHaveBeenCalledTimes(2);
	});

	it("defers legacy watermark recovery to post-send finalize without blocking send", async () => {
		const messagesListGate = Promise.withResolvers<void>();
		const recoveryCountStarted = Promise.withResolvers<void>();
		let messagesListCalls = 0;
		mockedMessagesList.mockImplementation(async () => {
			messagesListCalls++;
			if (messagesListCalls === 1) throw new Error("transcript unavailable");
			recoveryCountStarted.resolve();
			await messagesListGate.promise;
			return [];
		});

		const mockSend = vi.fn().mockImplementation(async () => {
			const sendIndex = mockSend.mock.calls.length;
			expect(mockedMessagesList).toHaveBeenCalledTimes(sendIndex - 1);
			const runId = `run-${sendIndex}`;
			return asMockCursorRun({
				id: runId,
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockResolvedValue({ id: runId, status: "finished", result: `turn-${sendIndex}` }),
			});
		});
		mockCreatedAgent({ send: mockSend });
		const firstContext = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel("composer-2"), firstContext, { apiKey: "test-key" }));
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockedMessagesList).toHaveBeenCalledTimes(1);

		const firstDone = getDoneEvent(firstEvents);
		const secondContext = makeContext([
			...firstContext.messages,
			firstDone.message,
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		const eventsPromise = collectEvents(streamCursor(makeModel("composer-2"), secondContext, { apiKey: "test-key" }));

		await recoveryCountStarted.promise;
		messagesListGate.resolve();
		const events = await eventsPromise;

		expect(getDoneEvent(events).reason).toBe("stop");
		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockedMessagesList.mock.calls.length).toBeGreaterThan(1);
	});

	it.each([
		{ sdkStatus: "finished" as const, sdkResult: "hello" },
		{ sdkStatus: "error" as const, sdkResult: "boom" },
	])(
		"treats caller abort during pending wait as cancelled when SDK resolves $sdkStatus",
		async ({ sdkStatus, sdkResult }) => {
			const controller = new AbortController();
			let resolveWait!: (value: { id: string; status: typeof sdkStatus; result?: string }) => void;
			const waitPromise = new Promise<{ id: string; status: typeof sdkStatus; result?: string }>((resolve) => {
				resolveWait = resolve;
			});
			const mockSend = vi.fn().mockResolvedValue(
				asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "running",
					wait: vi.fn().mockReturnValue(waitPromise),
					cancel: vi.fn().mockResolvedValue(undefined),
				}),
			);
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const stream = streamCursor(makeModel(), makeContext(), {
				apiKey: "test-key",
				signal: controller.signal,
			});
			const eventsPromise = collectEvents(stream);

			await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
			controller.abort();
			resolveWait({ id: "run-1", status: sdkStatus, result: sdkResult });

			const events = await eventsPromise;
			expect(getErrorEvent(events).reason).toBe("aborted");
			expect(hasEventType(events, "done")).toBe(false);
		},
	);

	it("cancels run on abort signal", async () => {
		const controller = new AbortController();
		const mockCancel = vi.fn().mockResolvedValue(undefined);
		let resolveWait: () => void;
		const waitPromise = new Promise<{ id: string; status: string }>((resolve) => {
			resolveWait = () => resolve({ id: "run-1", status: "cancelled" });
		});
		const mockSend = vi.fn().mockImplementation(async () => {
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockReturnValue(waitPromise),
				cancel: mockCancel,
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			signal: controller.signal,
		});

		// Give the async IIFE time to start the run
		await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());

		// Now abort
		controller.abort();

		// Let the run resolve
		resolveWait!();

		await collectEvents(stream);

		expect(mockCancel).toHaveBeenCalled();
	});

	it("removes abort listener when agent.send throws after listener registration", async () => {
		const controller = new AbortController();
		const removeListenerSpy = vi.spyOn(AbortSignal.prototype, "removeEventListener");
		const mockSend = vi.fn().mockRejectedValue(new Error("send failed"));
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			signal: controller.signal,
		});
		const events = await collectEvents(stream);

		expect(getErrorEvent(events).reason).toBe("error");
		expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
		removeListenerSpy.mockRestore();
	});

	it("emits start before sanitized error and disposes abort suppression when debug run dir setup fails", async () => {
		const invalidRunDirFile = join(tmpdir(), `pi-cursor-sdk-debug-run-dir-${process.pid}`);
		writeFileSync(invalidRunDirFile, "not-a-directory");
		const previousDebug = process.env.PI_CURSOR_SDK_EVENT_DEBUG;
		const previousRunDir = process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = invalidRunDirFile;

		try {
			expect(cursorSdkProcessGuardTestUtils.activeProviderTurnCount()).toBe(0);
			const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
			const events = await collectEvents(stream);
			const error = getErrorEvent(events);

			expect(hasEventType(events, "start")).toBe(true);
			expect(error.reason).toBe("error");
			expect(events.findIndex((event) => event.type === "start")).toBeLessThan(
				events.findIndex((event) => event.type === "error"),
			);
			expect(mockedCreate).not.toHaveBeenCalled();
			expect(cursorSdkProcessGuardTestUtils.activeProviderTurnCount()).toBe(0);
		} finally {
			rmSync(invalidRunDirFile, { force: true });
			if (previousDebug === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG = previousDebug;
			if (previousRunDir === undefined) delete process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR;
			else process.env.PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR = previousRunDir;
		}
	});
});

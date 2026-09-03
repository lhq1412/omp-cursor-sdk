import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKAgent, ToolName } from "@cursor/sdk";
import { sdkCursorBackend } from "../src/cursor-backend.js";
import { sendCursorProviderTurn } from "../src/cursor-provider-turn-send.js";
import type { CursorProviderTurnPrepareResult, CursorProviderTurnRunnerParams } from "../src/cursor-provider-turn-types.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

const {
	recordCursorCloudLifecycleSafely,
	sdkCreate,
	createAgentPlatform,
	loadLatest,
	saveCachedContextWindow,
} = vi.hoisted(() => ({
	recordCursorCloudLifecycleSafely: vi.fn(() => true),
	sdkCreate: vi.fn(),
	createAgentPlatform: vi.fn(),
	loadLatest: vi.fn(),
	saveCachedContextWindow: vi.fn(),
}));

vi.mock("../src/cursor-cloud-lifecycle.js", () => ({
	recordCursorCloudLifecycleSafely,
	createCursorCloudLifecyclePersistenceError: vi.fn(),
}));

vi.mock("../src/cursor-sdk-runtime.js", () => ({
	loadCursorSdk: vi.fn(async () => ({
		Agent: { create: sdkCreate, resume: vi.fn() },
		createAgentPlatform,
	})),
}));

vi.mock("../src/context-window-cache.js", () => ({
	getCheckpointContextWindow: (checkpoint: unknown) =>
		(checkpoint as { tokenDetails?: { maxTokens?: number } } | null)?.tokenDetails?.maxTokens,
	saveCachedContextWindow,
}));

function localAcquireParams(createAgent: (options: unknown) => Promise<unknown>) {
	return {
		apiKey: "test-key",
		agentMode: "agent" as const,
		cwd: "/tmp/project",
		modelSelection: { id: "composer-2.5" },
		createAgent: createAgent as NonNullable<Parameters<typeof acquireSessionCursorAgent>[0]["createAgent"]>,
	};
}
function backendLocalAcquireParams() {
	const { createAgent: _createAgent, ...params } = localAcquireParams(vi.fn());
	return params;
}

describe("cursor-backend", () => {
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
		recordCursorCloudLifecycleSafely.mockReturnValue(true);
	});

	it("local acquire hides the SDK agent and forwards send", async () => {
		const send = vi.fn().mockResolvedValue({ id: "run-1", agentId: "agent-1", status: "finished" });
		const dispose = vi.fn().mockResolvedValue(undefined);
		sdkCreate.mockResolvedValue({
			agentId: "agent-1",
			send,
			[Symbol.asyncDispose]: dispose,
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");

		const session = await sdkCursorBackend.acquire({
			runtimeTarget: "local",
			sessionAgent: backendLocalAcquireParams(),
		});

		expect(sdkCreate).toHaveBeenCalledTimes(1);
		expect(session.id).toBe("agent-1");
		expect("agent" in session).toBe(false);
		expect("lease" in session).toBe(false);
		const payload = { text: "hello" };
		const options = { mode: "agent" as const };
		await session.send({ payload, options });
		expect(send).toHaveBeenCalledWith(payload, options);
		createAgentPlatform.mockResolvedValue({ checkpointStore: { loadLatest } });
		loadLatest.mockResolvedValue({ tokenDetails: { maxTokens: 200_000 } });
		await session.cacheContextWindow("composer-2.5");
		expect(createAgentPlatform).toHaveBeenCalledWith(expect.objectContaining({
			workspaceRef: "/tmp/project",
			scopedWorkspaceRef: "/tmp/project",
			localStore: expect.any(Object),
		}));
		expect(loadLatest).toHaveBeenCalledWith("agent-1");
		expect(saveCachedContextWindow).toHaveBeenCalledWith("composer-2.5", 200_000);

		await session.dispose();
		expect(dispose).not.toHaveBeenCalled();
	});

	it("cloud acquire uses createAgent, send wraps agent.send, dispose calls asyncDispose", async () => {
		const send = vi.fn().mockResolvedValue({ id: "run-cloud", agentId: "bc-1", status: "finished" });
		const dispose = vi.fn().mockResolvedValue(undefined);
		const agent = {
			agentId: "bc-1",
			send,
			[Symbol.asyncDispose]: dispose,
		} as unknown as SDKAgent;
		sdkCreate.mockResolvedValue(agent);

		const session = await sdkCursorBackend.acquire({
			runtimeTarget: "cloud",
			options: { apiKey: "test-key", cloud: {} },
		});

		expect(sdkCreate).toHaveBeenCalledTimes(1);
		expect("agent" in session).toBe(false);
		expect(session.id).toBe("bc-1");
		expect("lease" in session).toBe(false);

		const payload = { text: "cloud" };
		const options = { mode: "agent" as const };
		await session.send({ payload, options });
		expect(send).toHaveBeenCalledWith(payload, options);

		await session.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("sendCursorProviderTurn sends through the backend session", async () => {
		const run = { id: "run-1", agentId: "agent-cloud", requestId: "req-1", status: "running", cancel: vi.fn() };
		const sessionSend = vi.fn().mockResolvedValue(run);
		const backendSession = {
			id: "agent-cloud",
			send: sessionSend,
			attachBilledTurnUsage: async () => ({}),
			collectRunReport: async () => ({ agentId: "agent-cloud", runId: "run-1", branches: [] }),
			dispose: async () => {},
		};
		const prepared = {
			runtimeTarget: "cloud",
			backendSession,
			cwd: "/tmp",
			payload: { text: "hi" },
			meta: {
				sendPlan: { mode: "bootstrap", resetAgent: false, reason: "initial" },
				prompt: { text: "hi", images: [] },
				bootstrap: true,
				promptInputTokens: 1,
				useNativeToolReplay: false,
				bridgeEnabled: false,
				nativeReplayId: "nr",
				agentMode: "agent",
				modelSelection: { id: "composer-2.5" },
			},
			textDeltas: [],
			restoreCursorSdkOutputFilter: () => {},
			lifecycle: {
				trackRunCompletion() {},
				commitSend() {},
				abandon: async () => {},
				dispose: async () => {},
			},
			runtime: {
				kind: "direct",
				turnCoordinator: { handleDelta() {}, handleStep() {} },
			},
		} as unknown as CursorProviderTurnPrepareResult;

		await sendCursorProviderTurn({
			params: { options: {} } as CursorProviderTurnRunnerParams,
			prepared,
			sdkEventDebug: undefined,
			sdkProcessErrorGuard: {
				suppressAbortErrors() {},
				containLocalTransportClosedPipe() {},
				dispose() {},
			},
			throwIfAborted: () => {},
			resolvedApiKey: "test-key",
		});

		expect(sessionSend).toHaveBeenCalledTimes(1);
		expect(sessionSend.mock.calls[0]?.[0]).toEqual({
			payload: { text: "hi" },
			options: expect.objectContaining({ mode: "agent" }),
		});
	});

	it("omits disallowedTools from Agent.create when unset", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");

		await acquireSessionCursorAgent(localAcquireParams(createAgent));

		expect(createAgent.mock.calls[0]?.[0]).not.toHaveProperty("disallowedTools");
	});

	it("passes non-empty disallowedTools on create and suffixes the pool key", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-exec",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			...localAcquireParams(createAgent),
			disallowedTools: ["read", "shell"] as ToolName[],
		};

		await acquireSessionCursorAgent(params);

		expect(createAgent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
			disallowedTools: ["read", "shell"],
		}));
		const baseKey = sessionAgentTestUtils.buildSessionAgentPoolKey("/tmp/sessions/test.jsonl", localAcquireParams(createAgent));
		const execKey = sessionAgentTestUtils.buildSessionAgentPoolKey("/tmp/sessions/test.jsonl", params);
		expect(execKey).toContain("omp-exec:read,shell");
		expect(baseKey).toContain("omp-exec:off");
		expect(execKey).not.toBe(baseKey);
	});
});

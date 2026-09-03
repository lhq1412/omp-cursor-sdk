import type { Run, SendOptions, SDKAgent } from "@cursor/sdk";
import {
	acquireSessionCursorAgent,
	type SessionCursorAgentLease,
} from "./cursor-session-agent.js";
import type { CursorProviderTurnSendPayload } from "./cursor-provider-turn-types.js";

// TODO(issue-11): align bootstrap/context conversion with OMP built-in cursor/* semantics.

export type CursorBackendRun = Run;

export interface CursorBackendSendInput {
	payload: CursorProviderTurnSendPayload;
	options?: SendOptions;
}

export interface CursorBackendSession {
	readonly id: string;
	readonly agent: SDKAgent;
	send(input: CursorBackendSendInput): Promise<CursorBackendRun>;
	reload?(): Promise<void>;
	dispose(): Promise<void>;
}

export interface LocalCursorBackendSession extends CursorBackendSession {
	readonly lease: SessionCursorAgentLease;
}

export type CursorBackendAcquireInput =
	| {
			runtimeTarget: "local";
			sessionAgent: Parameters<typeof acquireSessionCursorAgent>[0];
	  }
	| {
			runtimeTarget: "cloud";
			createAgent: () => Promise<SDKAgent>;
	  };

export interface CursorBackend {
	acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "local" }>): Promise<LocalCursorBackendSession>;
	acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "cloud" }>): Promise<CursorBackendSession>;
}

function wrapAgent(agent: SDKAgent): Pick<CursorBackendSession, "id" | "agent" | "send" | "reload"> {
	return {
		id: agent.agentId,
		agent,
		send: (input) => agent.send(input.payload, input.options),
		reload: async () => {
			await agent.reload?.();
		},
	};
}

class SdkCursorBackend implements CursorBackend {
	async acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "local" }>): Promise<LocalCursorBackendSession>;
	async acquire(input: Extract<CursorBackendAcquireInput, { runtimeTarget: "cloud" }>): Promise<CursorBackendSession>;
	async acquire(input: CursorBackendAcquireInput): Promise<LocalCursorBackendSession | CursorBackendSession> {
		if (input.runtimeTarget === "local") {
			const lease = await acquireSessionCursorAgent(input.sessionAgent);
			const localSession: LocalCursorBackendSession = {
				...wrapAgent(lease.agent),
				lease,
				dispose: async () => {},
			};
			return localSession;
		}
		const agent = await input.createAgent();
		return {
			...wrapAgent(agent),
			dispose: async () => {
				await agent[Symbol.asyncDispose]?.();
			},
		};
	}
}

export const sdkCursorBackend: CursorBackend = new SdkCursorBackend();

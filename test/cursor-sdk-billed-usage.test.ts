import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "@cursor/sdk";
import {
	__testUtils,
	attachCursorSdkBilledTurnUsage,
	fetchCursorSdkAgentUsage,
	initializeCursorLocalBilledUsage,
	isCursorSdkClientMintedRunId,
	selectCursorBilledTurnUsage,
	sumCursorSdkTurnUsage,
} from "../src/cursor-sdk-billed-usage.js";

const turnA = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 };
const turnB = { inputTokens: 20, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 2 };
const turnC = { inputTokens: 30, outputTokens: 4, cacheReadTokens: 12, cacheWriteTokens: 3 };

afterEach(() => {
	__testUtils.reset();
});

describe("cursor billed usage selection", () => {
	it("treats client-minted run IDs as cloud-only filters", () => {
		expect(isCursorSdkClientMintedRunId("run-aaaa")).toBe(true);
		expect(isCursorSdkClientMintedRunId("usage-uuid")).toBe(false);
	});

	it("matches cloud billed usage by runId and sums unseen local turns", () => {
		const agentUsage = {
			usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 3, totalTokens: 50 },
			runs: [
				{ runId: "run-aaaa", usage: turnA },
				{ runId: "usage-b", usage: turnB },
			],
		};
		expect(selectCursorBilledTurnUsage(agentUsage, { runtime: "cloud", runId: "run-aaaa" })).toEqual({
			turn: turnA,
			runIds: ["run-aaaa"],
		});
		expect(selectCursorBilledTurnUsage(agentUsage, { runtime: "local" })).toEqual({
			turn: sumCursorSdkTurnUsage([turnA, turnB]),
			runIds: ["run-aaaa", "usage-b"],
		});
		expect(selectCursorBilledTurnUsage(agentUsage, { runtime: "local", seenRunIds: new Set(["run-aaaa"]) })).toEqual({
			turn: turnB,
			runIds: ["usage-b"],
		});
	});

	it("does not pass a local client-minted runId into getUsage", async () => {
		const getUsage = vi.fn().mockResolvedValue({ usage: turnA, runs: [] });
		const agent = { getUsage } as unknown as SDKAgent;
		await fetchCursorSdkAgentUsage(agent, { runtime: "local", runId: "run-local-1" });
		expect(getUsage).toHaveBeenCalledWith(undefined);
		await fetchCursorSdkAgentUsage(agent, { runtime: "cloud", runId: "run-cloud-1" });
		expect(getUsage).toHaveBeenCalledWith({ runId: "run-cloud-1" });
	});

	it("baselines resumed history and charges only the current local turn", async () => {
		const getUsage = vi.fn()
			.mockResolvedValueOnce({
				usage: sumCursorSdkTurnUsage([turnA, turnB]),
				runs: [
					{ runId: "usage-a", usage: turnA },
					{ runId: "usage-b", usage: turnB },
				],
			})
			.mockResolvedValueOnce({
				usage: sumCursorSdkTurnUsage([turnA, turnB, turnC]),
				runs: [
					{ runId: "usage-a", usage: turnA },
					{ runId: "usage-b", usage: turnB },
					{ runId: "usage-c", usage: turnC },
				],
			});
		const agent = { getUsage } as unknown as SDKAgent;
		expect(await initializeCursorLocalBilledUsage(agent, "agent-resumed")).toBe(true);
		const billed = await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-resumed", runtime: "local" });
		expect(billed.turn).toEqual(turnC);
		expect(getUsage).toHaveBeenCalledTimes(2);
	});

	it("charges the first turn of a new local agent after an empty baseline", async () => {
		const getUsage = vi.fn()
			.mockResolvedValueOnce({ usage: {}, runs: [] })
			.mockResolvedValueOnce({ usage: turnA, runs: [{ runId: "usage-a", usage: turnA }] });
		const agent = { getUsage } as unknown as SDKAgent;
		expect(await initializeCursorLocalBilledUsage(agent, "agent-new")).toBe(true);
		const billed = await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-new", runtime: "local" });
		expect(billed.turn).toEqual(turnA);
	});

	it("deduplicates concurrent baselines and does not repeat a successful baseline", async () => {
		const getUsage = vi.fn().mockResolvedValue({ usage: turnA, runs: [{ runId: "usage-a", usage: turnA }] });
		const agent = { getUsage } as unknown as SDKAgent;
		await expect(Promise.all([
			initializeCursorLocalBilledUsage(agent, "agent-shared"),
			initializeCursorLocalBilledUsage(agent, "agent-shared"),
		])).resolves.toEqual([true, true]);
		await expect(initializeCursorLocalBilledUsage(agent, "agent-shared")).resolves.toBe(true);
		expect(getUsage).toHaveBeenCalledTimes(1);
	});

	it("baselines distinct SDKAgent handles even when they report the same agentId", async () => {
		const firstGetUsage = vi.fn().mockResolvedValue({ usage: {}, runs: [] });
		const secondGetUsage = vi.fn().mockResolvedValue({ usage: turnA, runs: [{ runId: "usage-a", usage: turnA }] });
		expect(await initializeCursorLocalBilledUsage({ getUsage: firstGetUsage } as unknown as SDKAgent, "shared-id")).toBe(true);
		expect(await initializeCursorLocalBilledUsage({ getUsage: secondGetUsage } as unknown as SDKAgent, "shared-id")).toBe(true);
		expect(firstGetUsage).toHaveBeenCalledTimes(1);
		expect(secondGetUsage).toHaveBeenCalledTimes(1);
	});

	it("watermarks baseline UUIDs even before their usage payload arrives", async () => {
		const getUsage = vi.fn()
			.mockResolvedValueOnce({ usage: {}, runs: [{ runId: "usage-history" }] })
			.mockResolvedValueOnce({
				usage: sumCursorSdkTurnUsage([turnA, turnB]),
				runs: [
					{ runId: "usage-history", usage: turnA },
					{ runId: "usage-current", usage: turnB },
				],
			});
		const agent = { getUsage } as unknown as SDKAgent;
		expect(await initializeCursorLocalBilledUsage(agent, "agent-delayed-history")).toBe(true);
		const billed = await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-delayed-history", runtime: "local" });
		expect(billed.turn).toEqual(turnB);
	});

	it("keeps newly reported UUIDs incremental without another baseline", async () => {
		const getUsage = vi.fn()
			.mockResolvedValueOnce({ usage: turnA, runs: [{ runId: "usage-a", usage: turnA }] })
			.mockResolvedValueOnce({ usage: turnA, runs: [{ runId: "usage-a", usage: turnA }] })
			.mockResolvedValueOnce({
				usage: sumCursorSdkTurnUsage([turnA, turnB, turnC]),
				runs: [
					{ runId: "usage-a", usage: turnA },
					{ runId: "usage-b-late", usage: turnB },
					{ runId: "usage-c", usage: turnC },
				],
			});
		const agent = { getUsage } as unknown as SDKAgent;
		await initializeCursorLocalBilledUsage(agent, "agent-eventual");
		expect((await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-eventual", runtime: "local" })).turn).toBeUndefined();
		expect((await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-eventual", runtime: "local" })).turn)
			.toEqual(sumCursorSdkTurnUsage([turnB, turnC]));
		expect(getUsage).toHaveBeenCalledTimes(3);
	});

	it("fails closed for one turn, then retries and baselines before the next", async () => {
		const getUsage = vi.fn()
			.mockRejectedValueOnce(new Error("usage unavailable"))
			.mockResolvedValueOnce({
				usage: sumCursorSdkTurnUsage([turnA, turnB]),
				runs: [
					{ runId: "usage-a", usage: turnA },
					{ runId: "usage-b", usage: turnB },
				],
			})
			.mockResolvedValueOnce({
				usage: sumCursorSdkTurnUsage([turnA, turnB, turnC]),
				runs: [
					{ runId: "usage-a", usage: turnA },
					{ runId: "usage-b", usage: turnB },
					{ runId: "usage-c", usage: turnC },
				],
			});
		const agent = { getUsage } as unknown as SDKAgent;
		expect(await initializeCursorLocalBilledUsage(agent, "agent-retry")).toBe(false);
		expect(await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-retry", runtime: "local" })).toEqual({});
		expect(await initializeCursorLocalBilledUsage(agent, "agent-retry")).toBe(true);
		expect((await attachCursorSdkBilledTurnUsage({ agent, agentId: "agent-retry", runtime: "local" })).turn).toEqual(turnC);
		expect(getUsage).toHaveBeenCalledTimes(3);
	});

	it("leaves cloud billed usage unchanged without a local baseline", async () => {
		const getUsage = vi.fn().mockResolvedValue({
			usage: turnA,
			runs: [{ runId: "run-cloud", usage: turnA }],
		});
		const agent = { getUsage } as unknown as SDKAgent;
		const billed = await attachCursorSdkBilledTurnUsage({
			agent,
			agentId: "bc-agent",
			runtime: "cloud",
			runId: "run-cloud",
		});
		expect(billed.turn).toEqual(turnA);
		expect(getUsage).toHaveBeenCalledWith({ runId: "run-cloud" });
	});

	it("returns undefined when getUsage is missing or times out", async () => {
		expect(await fetchCursorSdkAgentUsage({} as SDKAgent, { runtime: "local" })).toBeUndefined();
		const getUsage = vi.fn(() => new Promise(() => {}));
		const agent = { getUsage } as unknown as SDKAgent;
		await expect(fetchCursorSdkAgentUsage(agent, { runtime: "local" })).resolves.toBeUndefined();
	}, 8000);
});

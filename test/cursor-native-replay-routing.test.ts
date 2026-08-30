import { describe, it, expect, beforeEach } from "vitest";
import type { Context } from "@oh-my-pi/pi-ai";
import {
	__testUtils as nativeToolDisplayTestUtils,
	resolveRegisteredCursorNativeToolName,
} from "../src/cursor-native-tool-display-state.js";
import {
	isNativeToolActiveInContext,
	partitionNativeToolsByActiveContext,
	resolveNativeReplayDisposition,
} from "../src/cursor-native-replay-routing.js";

describe("cursor-native-replay-routing", () => {
	beforeEach(() => {
		nativeToolDisplayTestUtils.reset();
		nativeToolDisplayTestUtils.registerNativeToolNameForTests("cursor");
	});
	it("queues replay when tool is active in context and live run exists", () => {
		expect(
			resolveNativeReplayDisposition({
				toolName: "cursor",
				useNativeToolReplay: true,
				activeToolNames: new Set(["cursor", "read"]),
				hasLiveRun: true,
			}),
		).toBe("queue_replay");
	});

	it("returns inactive_trace when tool is missing from context snapshot", () => {
		expect(
			resolveNativeReplayDisposition({
				toolName: "cursor",
				useNativeToolReplay: true,
				activeToolNames: new Set(["read"]),
				hasLiveRun: true,
			}),
		).toBe("inactive_trace");
	});

	it("returns transcript_trace when native replay is disabled", () => {
		expect(
			resolveNativeReplayDisposition({
				toolName: "cursor",
				useNativeToolReplay: false,
				activeToolNames: new Set(["cursor"]),
				hasLiveRun: true,
			}),
		).toBe("transcript_trace");
	});

	it("maps SDK builtin activity onto OMP's neutral replay tool", () => {
		expect(resolveRegisteredCursorNativeToolName("read")).toBe("cursor");
		expect(resolveRegisteredCursorNativeToolName("bash")).toBe("cursor");
		expect(resolveRegisteredCursorNativeToolName("unknown")).toBeUndefined();
	});

	it("treats undefined activeToolNames as all tools active", () => {
		expect(isNativeToolActiveInContext("grep", undefined)).toBe(true);
	});

	it("partitions native tools by context.tools snapshot", () => {
		const context = {
			systemPrompt: "",
			messages: [],
			tools: [{ name: "read", description: "read", parameters: {} }],
		} as unknown as Context;
		const { active, inactive } = partitionNativeToolsByActiveContext(context, [
			{ toolName: "read", id: "1" },
			{ toolName: "grep", id: "2" },
		]);
		expect(active.map((t) => t.toolName)).toEqual(["read"]);
		expect(inactive.map((t) => t.toolName)).toEqual(["grep"]);
	});
});

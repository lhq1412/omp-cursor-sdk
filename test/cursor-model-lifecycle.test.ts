import { describe, expect, it, vi } from "vitest";
import { registerCursorModelLifecycle } from "../src/cursor-model-lifecycle.js";
import { createHarnessEventApi } from "./helpers/event-harness.js";
import { makeModel } from "./helpers/model-fixtures.js";

describe("registerCursorModelLifecycle", () => {
	it("runs one sync handler for effective model lifecycle phases", async () => {
		const events = createHarnessEventApi();
		const sync = vi.fn();
		registerCursorModelLifecycle(events, sync);

		const sessionModel = makeModel("session-model");
		const selectedModel = makeModel("selected-model");
		await events.runSessionStart({ model: sessionModel });
		// OMP has no model_select event; the port does not register it, so
		// invoking it here is a no-op (kept to pin the absence).
		await events.invokeEvent(
			"model_select",
			{ type: "model_select", model: selectedModel, previousModel: sessionModel, source: "set" },
			{ model: sessionModel },
		);
		await events.runTurnStart({ model: selectedModel });
		await events.runBeforeAgentStart({ model: selectedModel });

		expect(sync).toHaveBeenCalledTimes(3);
		expect(sync.mock.calls.map(([ctx]) => ctx.model?.id)).toEqual([
			"session-model",
			"selected-model",
			"selected-model",
		]);
	});

	it("runs phase-specific session and before-agent handlers through the same registration", async () => {
		const events = createHarnessEventApi();
		const calls: string[] = [];
		registerCursorModelLifecycle(events, {
			sessionStart: (_event, ctx) => {
				calls.push(`session:${ctx.model?.id}`);
			},
			sync: (ctx) => {
				calls.push(`sync:${ctx.model?.id}`);
			},
			beforeAgentStart: (event, ctx) => {
				calls.push(`before:${ctx.model?.id}:${event.systemPrompt}`);
				return { systemPrompt: [...event.systemPrompt, "updated"] };
			},
		});

		const model = makeModel("cursor-model");
		await events.runSessionStart({ model });
		const result = await events.runBeforeAgentStart({ model });

		expect(calls).toEqual([
			"session:cursor-model",
			"sync:cursor-model",
			"sync:cursor-model",
			"before:cursor-model:",
		]);
		expect(result).toEqual({ systemPrompt: ["updated"] });
	});

	it("does not invoke modelSelect (OMP has no model-change event) but runs turn-start", async () => {
		const events = createHarnessEventApi();
		const calls: string[] = [];
		registerCursorModelLifecycle(events, {
			modelSelect: (_event, ctx) => {
				calls.push(`select:${ctx.model?.id}`);
			},
			turnStart: (_event, ctx) => {
				calls.push(`turn:${ctx.model?.id}`);
			},
			beforeAgentStart: (event, ctx) => {
				calls.push(`before:${ctx.model?.id}`);
				return { systemPrompt: event.systemPrompt };
			},
		});

		const sessionModel = makeModel("session-model");
		const selectedModel = makeModel("selected-model");
		await events.invokeEvent(
			"model_select",
			{ type: "model_select", model: selectedModel, previousModel: sessionModel, source: "set" },
			{ model: sessionModel },
		);
		await events.runTurnStart({ model: selectedModel });
		await events.runBeforeAgentStart({ model: selectedModel });

		expect(calls).toEqual(["turn:selected-model", "before:selected-model"]);
	});
});

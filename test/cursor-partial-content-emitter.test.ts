import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { CursorPartialContentEmitter } from "../src/cursor-partial-content-emitter.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";

describe("CursorPartialContentEmitter first stream event", () => {
	it("reports the first thinking or text stream event once", () => {
		const stream = createAssistantMessageEventStream();
		const emitter = new CursorPartialContentEmitter(stream, makeAssistantMessage(""), -1, false);
		const seen: string[] = [];
		emitter.onFirstStreamEvent = (type) => {
			seen.push(type);
		};

		emitter.appendThinkingDelta("hmm");
		emitter.appendThinkingDelta(" more");
		emitter.appendTextDelta("hello");

		expect(seen).toEqual(["thinking_start"]);
	});
});

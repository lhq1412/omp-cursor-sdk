import { describe, expect, it } from "vitest";
import { modelRequiresCursorToolSchemaProjection } from "../src/model-discovery.js";

describe("OMP cursor tool-schema projection policy", () => {
	it("uses resolveModelPolicy catalog axis, not model-id substring heuristics", () => {
		expect(modelRequiresCursorToolSchemaProjection("claude-5-fable-high")).toBe(true);
		expect(modelRequiresCursorToolSchemaProjection("claude-5-fable-medium")).toBe(true);
		expect(modelRequiresCursorToolSchemaProjection("composer-2.5")).toBe(false);
		expect(modelRequiresCursorToolSchemaProjection("gpt-5.3-codex")).toBe(false);
		expect(modelRequiresCursorToolSchemaProjection("claude-4.6-sonnet-medium")).toBe(false);
		// Substring "fable" alone is not OMP catalog assignment
		expect(modelRequiresCursorToolSchemaProjection("fable")).toBe(false);
		expect(modelRequiresCursorToolSchemaProjection("my-fable-tool-model")).toBe(false);
		expect(modelRequiresCursorToolSchemaProjection("")).toBe(false);
	});
});

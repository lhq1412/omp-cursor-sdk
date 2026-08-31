import { describe, expect, it, vi } from "vitest";
import { Text } from "@oh-my-pi/pi-tui";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/omptype/typebox";
import { wrapNativeCursorTool } from "../src/cursor-native-tool-display-tools.js";
import { createRenderArgs, createRenderOptions, createRenderTheme } from "./helpers/render-fixtures.js";

describe("wrapNativeCursorTool", () => {
	it("preserves an existing definition's result renderer", () => {
		const parameters = Type.Object({});
		type EditToolDefinition = ToolDefinition<typeof parameters, unknown>;
		const delegateRenderResult = vi.fn<NonNullable<EditToolDefinition["renderResult"]>>(() => new Text("pi edit", 0, 0));
		const definition: EditToolDefinition = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters,
			execute: vi.fn(async () => ({ content: [], details: undefined })),
			renderResult: delegateRenderResult,
		};
		const wrapped = wrapNativeCursorTool(definition, () => definition);
		const theme = createRenderTheme();

		wrapped.renderResult?.(
			{
				content: [{ type: "text", text: "edit src/foo.ts" }],
				details: {
					path: "src/foo.ts",
					diffString: "--- a\n+++ b\n",
					linesAdded: 1,
					linesRemoved: 1,
				},
			},
			createRenderOptions(),
			theme,
			createRenderArgs({}),
		);

		expect(delegateRenderResult).toHaveBeenCalledOnce();
	});
});

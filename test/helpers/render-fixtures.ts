import type { RegisteredTool } from "./pi-harness-types.js";

type ToolRenderCall = NonNullable<RegisteredTool["renderCall"]>;
type ToolRenderResult = NonNullable<RegisteredTool["renderResult"]>;

export type HarnessRenderTheme = Parameters<ToolRenderCall>[2];
export type HarnessRenderResultOptions = Parameters<ToolRenderResult>[1];

export function createRenderTheme(overrides: Partial<HarnessRenderTheme> = {}): HarnessRenderTheme {
	return {
		fg: (_style: string, text: string) => text,
		bold: (text: string) => text,
		...overrides,
	} as HarnessRenderTheme;
}

export function createRenderOptions(overrides: Partial<HarnessRenderResultOptions> = {}): HarnessRenderResultOptions {
	return {
		expanded: false,
		isPartial: false,
		...overrides,
	};
}

export function createRenderArgs<T extends Record<string, unknown>>(args: T = {} as T): T {
	return args;
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cursorMcpToolTimeoutOverrideDefaults,
	installCursorMcpToolTimeoutOverride,
	isCursorSdkMcpConnectTimeoutStack,
	isCursorSdkMcpToolTimeoutStack,
	resolveCursorMcpConnectTimeoutMs,
	resolveCursorMcpToolTimeoutMs,
	restoreCursorMcpToolTimeoutOverride,
} from "../src/cursor-mcp-timeout-override.js";
import { streamCursor } from "../src/cursor-provider.js";
import {
	collectEvents,
	makeContext,
	makeModel,
	mockedCreate,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";

afterEach(() => {
	restoreCursorMcpToolTimeoutOverride();
});

function captureScheduledDelays(action: () => void): number[] {
	const nativeSetTimeout = globalThis.setTimeout;
	const delays: number[] = [];
	globalThis.setTimeout = ((
		_handler: Parameters<typeof setTimeout>[0],
		delay?: Parameters<typeof setTimeout>[1],
		..._args: unknown[]
	) => {
		delays.push(typeof delay === "number" ? delay : 0);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	try {
		action();
		return delays;
	} finally {
		restoreCursorMcpToolTimeoutOverride();
		globalThis.setTimeout = nativeSetTimeout;
	}
}

const CURSOR_SDK_MCP_TOOL_STACK = `Error
    at Protocol._setupTimeout (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)
    at Client.callTool (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)
    at McpSdkClient.callTool (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)`;
const CURSOR_SDK_MCP_CONNECT_STACK = CURSOR_SDK_MCP_TOOL_STACK
	.replace(/callTool/g, "listTools")
	.replace(/McpSdkClient\.listTools/, "McpSdkClient.getTools");

function withCapturedErrorStack(stack: string, action: () => void): void {
	const OriginalError = globalThis.Error;
	globalThis.Error = function (message?: string) {
		const error = new OriginalError(message);
		error.stack = stack;
		return error;
	} as ErrorConstructor;
	try {
		action();
	} finally {
		globalThis.Error = OriginalError;
	}
}

function scheduleSyntheticCursorSdkMcpListToolsTimeout(callback: () => void): ReturnType<typeof setTimeout> {
	const sdkUrl = pathToFileURL(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js")).href;
	const source = `
return (() => {
	class Protocol {
		_setupTimeout() {
			return setTimeout(callback, 60000);
		}

		request() {
			return this._setupTimeout();
		}
	}

	class Client extends Protocol {
		listTools() {
			return this.request();
		}
	}

	class McpSdkClient {
		constructor() {
			this.client = new Client();
		}

		getTools() {
			return this.client.listTools();
		}
	}

	return new McpSdkClient().getTools();
})();
//# sourceURL=${sdkUrl}
`;
	const run = new Function("callback", source) as (callback: () => void) => ReturnType<typeof setTimeout>;
	return run(callback);
}

function scheduleSyntheticCursorSdkMcpInitializeTimeout(callback: () => void): ReturnType<typeof setTimeout> {
	const sdkUrl = pathToFileURL(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js")).href;
	const source = `
return (() => {
	class Protocol {
		_setupTimeout() {
			return setTimeout(callback, 60000);
		}

		request() {
			return this._setupTimeout();
		}
	}

	class Client extends Protocol {
		connect() {
			return this.request();
		}
	}

	return new Client().connect();
})();
//# sourceURL=${sdkUrl}
`;
	const run = new Function("callback", source) as (callback: () => void) => ReturnType<typeof setTimeout>;
	return run(callback);
}

function scheduleSyntheticCursorSdkMcpUnknownProtocolTimeout(callback: () => void): ReturnType<typeof setTimeout> {
	const sdkUrl = pathToFileURL(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js")).href;
	const source = `
return (() => {
	class Protocol {
		_setupTimeout() {
			return setTimeout(callback, 60000);
		}

		request() {
			return this._setupTimeout();
		}
	}

	class Client extends Protocol {
		listPrompts() {
			return this.request();
		}
	}

	return new Client().listPrompts();
})();
//# sourceURL=${sdkUrl}
`;
	const run = new Function("callback", source) as (callback: () => void) => ReturnType<typeof setTimeout>;
	return run(callback);
}

function scheduleSyntheticCursorSdkMcpToolTimeout(callback: () => void): ReturnType<typeof setTimeout> {
	const sdkUrl = pathToFileURL(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/index.js")).href;
	const source = `
return (() => {
	class Protocol {
		_setupTimeout() {
			return setTimeout(callback, 60000);
		}

		request() {
			return this._setupTimeout();
		}
	}

	class Client extends Protocol {
		callTool() {
			return this.request();
		}
	}

	class McpSdkClient {
		constructor() {
			this.client = new Client();
		}

		callTool() {
			return this.client.callTool();
		}
	}

	return new McpSdkClient().callTool();
})();
//# sourceURL=${sdkUrl}
`;
	const run = new Function("callback", source) as (callback: () => void) => ReturnType<typeof setTimeout>;
	return run(callback);
}

function readCursorSdkEsmBundleContaining(...markers: string[]): string {
	const sdkEsmDir = join(process.cwd(), "node_modules/@cursor/sdk/dist/esm");
	const hits = readdirSync(sdkEsmDir).flatMap((fileName) => {
		if (!fileName.endsWith(".js")) return [];
		const source = readFileSync(join(sdkEsmDir, fileName), "utf8");
		return markers.every((marker) => source.includes(marker)) ? [{ fileName, source }] : [];
	});

	expect(hits.map((hit) => hit.fileName)).toHaveLength(1);
	return hits[0]!.source;
}

describe("Cursor MCP timeout override", () => {
	it("tracks the installed Cursor SDK MCP callTool timeout seam", () => {
		const sdkMcpBundle = readCursorSdkEsmBundleContaining(
			'withName("McpSdkClient.callTool")',
			'this.client.callTool({name:t,arguments:r})',
		);
		const sdkProtocolBundle = readCursorSdkEsmBundleContaining(
			'this.request({method:"initialize"',
			"timeoutId:setTimeout",
		);

		expect(sdkMcpBundle).toContain('withName("McpSdkClient.callTool")');
		expect(sdkMcpBundle).toContain('this.client.callTool({name:t,arguments:r})');
		expect(sdkMcpBundle).toContain('withName("McpSdkClient.getTools")');
		expect(sdkMcpBundle).toContain('this.client.listTools({cursor:e})');
		expect(sdkProtocolBundle).toContain('this.request({method:"initialize"');
		expect(sdkProtocolBundle).toContain('_setupTimeout(e,t,n,s,i=!1)');
		expect(sdkProtocolBundle).toContain('timeoutId:setTimeout(s,t)');
	});

	it("recognizes the Cursor SDK MCP tool-call timeout stack shape", () => {
		const stack = `Error
    at Protocol._setupTimeout (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)
    at Client.callTool (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)
    at McpSdkClient.callTool (${process.cwd()}/node_modules/@cursor/sdk/dist/esm/index.js:1:1)`;

		const listToolsStack = stack.replace(/callTool/g, "listTools").replace(/McpSdkClient\.listTools/, "McpSdkClient.getTools");
		const initializeStack = stack.replace(/callTool/g, "connect");
		const unknownProtocolStack = stack.replace(/callTool/g, "listPrompts");

		expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(true);
		expect(isCursorSdkMcpToolTimeoutStack(listToolsStack)).toBe(false);
		expect(isCursorSdkMcpConnectTimeoutStack(listToolsStack)).toBe(true);
		expect(isCursorSdkMcpConnectTimeoutStack(initializeStack)).toBe(true);
		expect(isCursorSdkMcpConnectTimeoutStack(unknownProtocolStack)).toBe(false);
		expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack(stack.replace(/node_modules\/\@cursor\/sdk/g, "src"))).toBe(false);
	});

	it("installs the override before Cursor session agent acquisition", async () => {
		await resetCursorProviderTestState();
		const timeoutBeforeAcquire = globalThis.setTimeout;
		let timeoutAtAcquire: typeof setTimeout | undefined;
		mockedCreate.mockImplementation(async () => {
			timeoutAtAcquire = globalThis.setTimeout;
			throw new Error("stop before Cursor agent creation");
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5"), makeContext(), { apiKey: "test-key" }));

		expect(mockedCreate).toHaveBeenCalledOnce();
		expect(timeoutAtAcquire).toBeDefined();
		expect(timeoutAtAcquire).not.toBe(timeoutBeforeAcquire);
	});

	it("extends only the Cursor SDK MCP tool-call default timeout", () => {
		const callback = vi.fn();
		const delays = captureScheduledDelays(() => {
			installCursorMcpToolTimeoutOverride({ timeoutMs: 3_600_000 });
			withCapturedErrorStack(CURSOR_SDK_MCP_TOOL_STACK, () => {
				scheduleSyntheticCursorSdkMcpToolTimeout(callback);
			});
		});

		expect(delays).toEqual([3_600_000]);
		expect(callback).not.toHaveBeenCalled();
	});

	it("shortens known Cursor SDK MCP initialize and listTools default timeouts", () => {
		const listToolsCallback = vi.fn();
		const initializeCallback = vi.fn();
		const delays = captureScheduledDelays(() => {
			installCursorMcpToolTimeoutOverride({ connectTimeoutMs: 10_000 });
			withCapturedErrorStack(CURSOR_SDK_MCP_CONNECT_STACK, () => {
				scheduleSyntheticCursorSdkMcpListToolsTimeout(listToolsCallback);
				scheduleSyntheticCursorSdkMcpInitializeTimeout(initializeCallback);
			});
		});

		expect(delays).toEqual([10_000, 10_000]);
		expect(listToolsCallback).not.toHaveBeenCalled();
		expect(initializeCallback).not.toHaveBeenCalled();
	});

	it("does not shorten unknown Cursor SDK MCP protocol default timeouts", () => {
		const callback = vi.fn();
		const delays = captureScheduledDelays(() => {
			installCursorMcpToolTimeoutOverride({ connectTimeoutMs: 10_000 });
			scheduleSyntheticCursorSdkMcpUnknownProtocolTimeout(callback);
		});

		expect(delays).toEqual([60_000]);
		expect(callback).not.toHaveBeenCalled();
	});

	it("uses a 10s connect default and supports explicit connect overrides", () => {
		expect(resolveCursorMcpConnectTimeoutMs({})).toBe(
			cursorMcpToolTimeoutOverrideDefaults.defaultConnectTimeoutMs,
		);
		expect(
			resolveCursorMcpConnectTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.connectTimeoutSecondsEnv]: "5",
			}),
		).toBe(5_000);
		expect(
			resolveCursorMcpConnectTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.connectTimeoutMsEnv]: "500",
			}),
		).toBe(cursorMcpToolTimeoutOverrideDefaults.minConnectTimeoutMs);
		expect(
			resolveCursorMcpConnectTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.connectTimeoutMsEnv]: "120000",
			}),
		).toBe(cursorMcpToolTimeoutOverrideDefaults.cursorSdkDefaultTimeoutMs);
	});

	it("does not extend unrelated 60s timers", () => {
		const callback = vi.fn();
		const delays = captureScheduledDelays(() => {
			installCursorMcpToolTimeoutOverride({ timeoutMs: 3_600_000 });
			setTimeout(callback, 60_000);
		});

		expect(delays).toEqual([60_000]);
		expect(callback).not.toHaveBeenCalled();
	});

	it("keeps non-default timer calls on the cheap no-stack fast path", () => {
		const OriginalError = globalThis.Error;
		let stackCaptures = 0;
		const CountingError = function (message?: string) {
			stackCaptures += 1;
			return new OriginalError(message);
		} as ErrorConstructor;
		globalThis.Error = CountingError;
		try {
			const delays = captureScheduledDelays(() => {
				installCursorMcpToolTimeoutOverride({ timeoutMs: 3_600_000 });
				setTimeout(vi.fn(), 1);
				expect(stackCaptures).toBe(0);
				setTimeout(vi.fn(), 60_000);
				expect(stackCaptures).toBe(1);
			});
			expect(delays).toEqual([1, 60_000]);
		} finally {
			globalThis.Error = OriginalError;
		}
	});

	it("uses a 3600s default and supports explicit second or millisecond overrides", () => {
		expect(resolveCursorMcpToolTimeoutMs({})).toBe(
			cursorMcpToolTimeoutOverrideDefaults.defaultOverrideTimeoutMs,
		);
		expect(
			resolveCursorMcpToolTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.timeoutSecondsEnv]: "120",
			}),
		).toBe(120_000);
		expect(
			resolveCursorMcpToolTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.timeoutMsEnv]: "250000",
				[cursorMcpToolTimeoutOverrideDefaults.timeoutSecondsEnv]: "120",
			}),
		).toBe(250_000);
		expect(
			resolveCursorMcpToolTimeoutMs({
				[cursorMcpToolTimeoutOverrideDefaults.timeoutMsEnv]: "999999999999",
			}),
		).toBe(cursorMcpToolTimeoutOverrideDefaults.maxNodeTimerDelayMs);
	});
});

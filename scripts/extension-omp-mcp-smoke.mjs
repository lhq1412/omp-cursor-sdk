#!/usr/bin/env node
/**
 * Live structural smoke: PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS=1 skips loopback
 * pi_tools MCP (no bridgeRunId, send.bridgeEnabled=false). Does not prove cancel.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { parseDebugProviderEventsArgs, runDebugProviderEvents } from "./debug-provider-events.mjs";

const fail = createScriptFail("extension-omp-mcp-smoke");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function isMainModule() {
	return process.argv[1]?.endsWith("extension-omp-mcp-smoke.mjs");
}

function resolvePiCodingAgentCursorSource() {
	return join(repoRoot, "node_modules/@oh-my-pi/pi-coding-agent/src/cursor.ts");
}

/** Contract probe: OMP CursorExecBridge.executeTool still omits AbortSignal. */
export function hostExecuteToolOmitsAbortSignal() {
	const source = readFileSync(resolvePiCodingAgentCursorSource(), "utf8");
	const start = source.indexOf("async function executeTool");
	if (start === -1) fail("could not locate executeTool in @oh-my-pi/pi-coding-agent");
	const slice = source.slice(start, start + 2500);
	return /await tool\.execute\([\s\S]{0,240}\bundefined\b/.test(slice);
}

export async function runExtensionOmpMcpSmoke(argv = process.argv.slice(2), baseEnv = process.env) {
	const hostCancelGapOpen = hostExecuteToolOmitsAbortSignal();
	const env = {
		...baseEnv,
		PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS: "1",
		PI_CURSOR_TOOL_MANIFEST: "1",
		PI_CURSOR_PI_TOOL_BRIDGE: "1",
	};
	const args = parseDebugProviderEventsArgs(argv, env);
	if (!argv.some((arg, index) => arg === "--model" && argv[index + 1])) {
		args.model = "cursor-sdk/composer-2.5";
	}
	if (!args.prompt?.trim()) args.prompt = "Reply with exactly: EXTENSION_SMOKE_OK";

	const result = await runDebugProviderEvents(args, env);
	if (!result.waitResultRecorded) {
		fail("provider turn did not record wait result (see errors.jsonl in artifact dir)");
	}
	const metadataPath = join(result.artifactDir, "metadata.json");
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
	const bridgeRunId = metadata.providerMeta?.bridgeRunId;
	const bridgeEnabled = metadata.send?.bridgeEnabled;

	if (bridgeRunId !== undefined && bridgeRunId !== null) {
		fail(`expected no bridgeRunId with extension customTools opt-in, got ${String(bridgeRunId)}`);
	}
	if (bridgeEnabled !== false) {
		fail(`expected send.bridgeEnabled=false, got ${String(bridgeEnabled)}`);
	}

	const evidence = {
		status: "passed",
		lane: "extension-omp-mcp-structural",
		artifactDir: result.artifactDir,
		hostCancelGapOpen,
		bridgeRunId: bridgeRunId ?? null,
		bridgeEnabled,
		activeToolNameCount: metadata.providerMeta?.activeToolNames?.length ?? 0,
		waitResultRecorded: result.waitResultRecorded,
		elapsedMs: result.elapsedMs,
		model: result.model,
		extensionVersion: result.extensionVersion,
		sdkVersion: result.sdkVersion,
	};
	return evidence;
}

async function main() {
	const evidence = await runExtensionOmpMcpSmoke();
	process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (isMainModule()) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}

#!/usr/bin/env node
/**
 * Live structural smoke: PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS=1 skips loopback
 * pi_tools MCP (no bridgeRunId, send.bridgeEnabled=false). Does not prove cancel.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

function resolveInstalledHostPackageVersion() {
	const packageJsonPath = join(repoRoot, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
	if (existsSync(packageJsonPath)) {
		try {
			return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
		} catch {
			// fall through
		}
	}
	return "unknown";
}

function resolveSpawnedOmpVersion() {
	try {
		const out = execFileSync("omp", ["--version"], { encoding: "utf8", timeout: 5000 });
		return out.trim();
	} catch {
		return "unknown";
	}
}

/** Contract probe: OMP CursorExecBridge.executeTool still omits AbortSignal. */
export function hostExecuteToolOmitsAbortSignal() {
	const sourcePath = resolvePiCodingAgentCursorSource();
	if (!existsSync(sourcePath)) {
		return { status: "unknown", gap: null, path: sourcePath };
	}
	const source = readFileSync(sourcePath, "utf8");
	const start = source.indexOf("async function executeTool");
	if (start === -1) {
		return { status: "unknown", gap: null, path: sourcePath };
	}
	const slice = source.slice(start, start + 2500);
	const hasUndefinedSignal = /await tool\.execute\([\s\S]{0,240}\bundefined\b/.test(slice);
	return {
		status: hasUndefinedSignal ? "observed-gap" : "changed-or-unknown",
		gap: hasUndefinedSignal,
		path: sourcePath,
	};
}

export async function runExtensionOmpMcpSmoke(argv = process.argv.slice(2), baseEnv = process.env) {
	const cancelProbe = hostExecuteToolOmitsAbortSignal();
	const env = {
		...baseEnv,
		PI_CURSOR_RUNTIME: "local",
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

	const waitResultPath = join(result.artifactDir, "wait-result.json");
	let waitResultStatus = "unknown";
	if (existsSync(waitResultPath)) {
		try {
			const waitResult = JSON.parse(readFileSync(waitResultPath, "utf8"));
			waitResultStatus = waitResult?.status ?? "unknown";
		} catch {
			// fall through
		}
	}
	const runFinishedSuccessfully = waitResultStatus === "finished";

	const metadataPath = join(result.artifactDir, "metadata.json");
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
	const bridgeRunId = metadata.providerMeta?.bridgeRunId;
	const bridgeEnabled = metadata.send?.bridgeEnabled;
	const activeToolNames = metadata.providerMeta?.activeToolNames ?? [];
	const manifest = metadata.providerMeta?.promptOptions?.toolManifest ?? "";
	const extensionCustomToolsListedInManifest = manifest.includes("OMP extension customTools (handlers.mcp)");

	if (bridgeRunId !== undefined && bridgeRunId !== null) {
		fail(`expected no bridgeRunId with extension customTools opt-in, got ${String(bridgeRunId)}`);
	}
	if (bridgeEnabled !== false) {
		fail(`expected send.bridgeEnabled=false, got ${String(bridgeEnabled)}`);
	}
	if (!extensionCustomToolsListedInManifest) {
		fail("expected tool manifest to list OMP extension customTools (handlers.mcp)");
	}
	if (activeToolNames.length === 0) {
		fail("expected activeToolNames to be non-empty in metadata.json");
	}

	const evidence = {
		status: runFinishedSuccessfully ? "passed" : "incomplete",
		lane: "extension-omp-mcp-structural",
		artifactDir: result.artifactDir,
		captureComplete: true,
		structuralAssertionsPassed: true,
		runFinishedSuccessfully,
		waitResultStatus,
		hostCancelGap: cancelProbe.status,
		hostCancelGapOpen: cancelProbe.gap === true,
		probeSourcePath: cancelProbe.path,
		installedHostPackageVersion: resolveInstalledHostPackageVersion(),
		spawnedOmpVersion: resolveSpawnedOmpVersion(),
		bridgeRunId: bridgeRunId ?? null,
		bridgeEnabled,
		activeToolNameCount: activeToolNames.length,
		activeToolNames,
		extensionCustomToolsListedInManifest,
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

#!/usr/bin/env node
/**
 * Cancel gate smoke for extension MCP customTools path.
 * Default: probe-only (no Cursor key). Live body runs only after OMP host closes the gap.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import {
	hostExecuteToolOmitsAbortSignal,
	resolveInstalledHostPackageVersion,
} from "./lib/cursor-host-cancel-probe.mjs";

const fail = createScriptFail("extension-omp-mcp-cancel-smoke");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PROPOSAL_DOC = "docs/omp-handlers-mcp-cancel-proposal.md";

function isMainModule() {
	return process.argv[1]?.endsWith("extension-omp-mcp-cancel-smoke.mjs");
}

function printHelp() {
	console.log(`Extension MCP cancel gate smoke for omp-cursor-sdk.

Usage:
  node scripts/extension-omp-mcp-cancel-smoke.mjs [options]

Options:
  -h, --help       Show this help.
  --self-test      Probe installed OMP; expect host cancel gap open on current releases.
  --live           Run live cancel scenario (requires upstream host signal wiring).

Exit codes:
  0  blocked gate documented, self-test passed, or live cancel passed
  1  validation failure or live run failed
  2  invalid command-line usage

Notes:
  - Default mode needs no CURSOR_API_KEY; it records the host cancel gap only.
  - See ${PROPOSAL_DOC} for the minimal OMP upstream patch.
`);
}

function parseArgs(argv) {
	const options = { selfTest: false, live: false, help: false };
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--self-test") options.selfTest = true;
		else if (arg === "--live") options.live = true;
		else {
			console.error(`extension-omp-mcp-cancel-smoke: unknown argument: ${arg}`);
			process.exit(2);
		}
	}
	if (options.selfTest && options.live) {
		console.error("extension-omp-mcp-cancel-smoke: --self-test and --live are mutually exclusive");
		process.exit(2);
	}
	return options;
}

function resolveSpawnedOmpVersion() {
	try {
		const out = execFileSync("omp", ["--version"], { encoding: "utf8", timeout: 5000 });
		return out.trim();
	} catch {
		return "unknown";
	}
}

export function buildExtensionOmpMcpCancelEvidence(options = {}) {
	const cancelProbe = hostExecuteToolOmitsAbortSignal(repoRoot);
	const hostCancelGapOpen = cancelProbe.gap === true;
	const base = {
		lane: "extension-omp-mcp-cancel",
		hostCancelGap: cancelProbe.status,
		hostCancelGapOpen,
		probeSourcePath: cancelProbe.path,
		installedHostPackageVersion: resolveInstalledHostPackageVersion(repoRoot),
		spawnedOmpVersion: resolveSpawnedOmpVersion(),
		proposalDoc: PROPOSAL_DOC,
	};

	if (hostCancelGapOpen) {
		return {
			...base,
			status: "blocked",
			liveCancelRunnable: false,
			nextSteps: [
				`Land OMP upstream patch described in ${PROPOSAL_DOC}`,
				"Re-run: npm run smoke:extension-mcp-cancel -- --self-test (gap should close)",
				"Then: npm run smoke:extension-mcp-cancel -- --live",
			],
		};
	}

	return {
		...base,
		status: options.liveAttempted ? "live-pending" : "ready",
		liveCancelRunnable: true,
		nextSteps: [
			"Host cancel gap closed; implement live in-flight abort assertions in --live mode",
			"Assert: subprocess/task stop, no post-cancel writes, no cross-session backfill",
		],
	};
}

export async function runExtensionOmpMcpCancelSmoke(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help) {
		printHelp();
		return { status: "help" };
	}

	if (options.selfTest) {
		const evidence = buildExtensionOmpMcpCancelEvidence();
		if (!evidence.hostCancelGapOpen) {
			fail(
				"self-test expected host cancel gap to remain open on current OMP; probe reported gap closed — update self-test expectations",
			);
		}
		return { ...evidence, status: "self-test-pass" };
	}

	if (options.live) {
		const evidence = buildExtensionOmpMcpCancelEvidence({ liveAttempted: true });
		if (evidence.hostCancelGapOpen) {
			fail(
				`live cancel smoke blocked: OMP host still omits AbortSignal in executeTool (see ${PROPOSAL_DOC})`,
			);
		}
		fail(
			"live cancel smoke body not implemented yet; host gap probe passed — add RPC abort + post-cancel assertions next",
		);
	}

	return buildExtensionOmpMcpCancelEvidence();
}

async function main() {
	const evidence = await runExtensionOmpMcpCancelSmoke();
	if (evidence.status === "help") return;
	if (evidence.status === "self-test-pass") {
		process.stdout.write("self-test PASS\n");
		return;
	}
	process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (isMainModule()) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}

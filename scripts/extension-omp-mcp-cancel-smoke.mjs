#!/usr/bin/env node
/**
 * Cancel gate smoke for extension MCP customTools path.
 * Default: probe-only (no Cursor key). Live body runs only after OMP host wires signal.
 *
 * Exit codes:
 *   0  probe-only diagnostic finished, or self-test passed
 *   1  validation failure or live run failed / not ready
 *   2  invalid CLI usage
 *
 * Probe statuses never imply cancel-gate pass. Only a future --live with stop
 * assertions may exit 0 as cancellation acceptance.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import {
	classifyAgentToolExecuteSignalArg,
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
  --self-test      Fixture-based probe classification (open / unknown / wiring).
  --live           Run live cancel scenario (requires host signal wiring + body).

Exit codes:
  0  probe-only diagnostic finished, or self-test passed
  1  validation failure or live run failed / not ready
  2  invalid command-line usage

Notes:
  - Default mode needs no CURSOR_API_KEY; it records the host cancel probe only.
  - Exit 0 on blocked/unknown is diagnostic success, NOT cancel-gate pass.
  - See ${PROPOSAL_DOC} for the minimal OMP upstream patch (AgentTool signal = 3rd arg).
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

/**
 * Map probe → gate evidence.
 * unknown / source-wiring-observed never alone mean cancel-gate pass.
 */
export function buildExtensionOmpMcpCancelEvidence(probe = hostExecuteToolOmitsAbortSignal(repoRoot)) {
	const base = {
		lane: "extension-omp-mcp-cancel",
		hostCancelGap: probe.status,
		hostCancelGapOpen: probe.gap === true,
		probeThirdArg: probe.thirdArg ?? null,
		probeSourcePath: probe.path,
		installedHostPackageVersion: resolveInstalledHostPackageVersion(repoRoot),
		spawnedOmpVersion: resolveSpawnedOmpVersion(),
		proposalDoc: PROPOSAL_DOC,
	};

	if (probe.gap === true || probe.status === "open") {
		return {
			...base,
			status: "blocked",
			liveCancelRunnable: false,
			nextSteps: [
				`Land OMP upstream patch in ${PROPOSAL_DOC} (AgentTool execute 3rd arg = signal)`,
				"Re-run: npm run smoke:extension-mcp-cancel (expect source-wiring-observed, still not gate pass)",
				"Then implement: npm run smoke:extension-mcp-cancel -- --live",
			],
		};
	}

	if (probe.status === "source-wiring-observed") {
		return {
			...base,
			status: "source-wiring-observed",
			liveCancelRunnable: true,
			nextSteps: [
				"Host source appears to pass a signal-like 3rd arg; implement --live stop assertions",
				"Assert: same in-flight call, subprocess/task stop, no post-cancel writes, control call OK",
			],
		};
	}

	// unknown and any other status: never claim ready
	return {
		...base,
		status: "unknown",
		liveCancelRunnable: false,
		nextSteps: [
			"Probe could not classify host executeTool wiring; do not treat as gap closed",
			`Check ${probe.path || "pi-coding-agent/src/cursor.ts"} and ${PROPOSAL_DOC}`,
		],
	};
}

/** Fixture self-test: classification only; does not claim product cancel safety. */
export function runCancelProbeSelfTest() {
	const cases = [
		{
			name: "explicit-undefined-third",
			source: `
async function executeTool(options, toolName, toolCallId, args) {
  result = await tool.execute(
    toolCallId,
    toolArgs,
    undefined,
    onUpdate,
    options.getToolContext?.(),
  );
}
`,
			expectStatus: "open",
			expectGap: true,
		},
		{
			name: "signal-third-arg",
			source: `
async function executeTool(options, toolName, toolCallId, args, overrideTool, signal) {
  result = await tool.execute(toolCallId, toolArgs, signal, onUpdate, options.getToolContext?.());
}
`,
			expectStatus: "source-wiring-observed",
			expectGap: false,
		},
		{
			name: "wrong-fifth-arg-still-undefined-third",
			source: `
async function executeTool() {
  result = await tool.execute(toolCallId, toolArgs, undefined, onUpdate, ctx, signal);
}
`,
			expectStatus: "open",
			expectGap: true,
		},
		{
			name: "comment-only-signal",
			source: `
async function executeTool() {
  result = await tool.execute(
    toolCallId,
    toolArgs,
    undefined, // signal intentionally omitted
    onUpdate,
    ctx,
  );
}
`,
			expectStatus: "open",
			expectGap: true,
		},
		{
			name: "trailing-audit-signal",
			source: `
async function executeTool() {
  result = await tool.execute(toolCallId, toolArgs, undefined, onUpdate, ctx);
  audit(signal);
}
`,
			expectStatus: "open",
			expectGap: true,
		},
		{
			name: "abortToken-third",
			source: `
async function executeTool() {
  result = await tool.execute(toolCallId, toolArgs, abortToken, onUpdate, ctx);
}
`,
			expectStatus: "source-wiring-observed",
			expectGap: false,
		},
		{
			name: "missing-executeTool",
			source: `export function other() { return 1 }`,
			expectStatus: "unknown",
			expectGap: null,
		},
		{
			name: "fifth-param-onUpdate-third",
			source: `
async function executeTool() {
  await tool.execute(toolCallId, toolArgs, onUpdate, ctx, signal);
}
`,
			expectStatus: "unknown",
			expectGap: null,
		},
	];

	const failures = [];
	for (const c of cases) {
		const got = classifyAgentToolExecuteSignalArg(c.source, c.name);
		if (got.status !== c.expectStatus || got.gap !== c.expectGap) {
			failures.push({
				name: c.name,
				expected: { status: c.expectStatus, gap: c.expectGap },
				got: { status: got.status, gap: got.gap, thirdArg: got.thirdArg },
			});
		}
	}

	const unknownEvidence = buildExtensionOmpMcpCancelEvidence({
		status: "unknown",
		gap: null,
		thirdArg: null,
		path: "missing.ts",
	});
	if (unknownEvidence.status !== "unknown" || unknownEvidence.liveCancelRunnable !== false) {
		failures.push({
			name: "unknown-evidence-not-ready",
			expected: { status: "unknown", liveCancelRunnable: false },
			got: {
				status: unknownEvidence.status,
				liveCancelRunnable: unknownEvidence.liveCancelRunnable,
			},
		});
	}

	return { ok: failures.length === 0, failures, caseCount: cases.length };
}

export async function runExtensionOmpMcpCancelSmoke(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help) {
		printHelp();
		return { status: "help" };
	}

	if (options.selfTest) {
		const result = runCancelProbeSelfTest();
		if (!result.ok) {
			fail(`self-test failed: ${JSON.stringify(result.failures, null, 2)}`);
		}
		return { status: "self-test-pass", caseCount: result.caseCount };
	}

	const evidence = buildExtensionOmpMcpCancelEvidence();

	if (options.live) {
		if (evidence.status === "blocked" || evidence.hostCancelGapOpen) {
			fail(
				`live cancel smoke blocked: OMP host still omits AbortSignal as AgentTool 3rd arg (see ${PROPOSAL_DOC})`,
			);
		}
		if (evidence.status === "unknown" || !evidence.liveCancelRunnable) {
			fail(`live cancel smoke not runnable: probe status=${evidence.status} (see ${PROPOSAL_DOC})`);
		}
		fail(
			"live cancel smoke body not implemented yet; host source wiring observed — add RPC abort + post-cancel assertions next",
		);
	}

	return evidence;
}

async function main() {
	const evidence = await runExtensionOmpMcpCancelSmoke();
	if (evidence.status === "help") return;
	if (evidence.status === "self-test-pass") {
		process.stdout.write(`self-test PASS (${evidence.caseCount} fixtures)\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (isMainModule()) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}

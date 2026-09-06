import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	buildExtensionOmpMcpCancelEvidence,
	runCancelProbeSelfTest,
	runExtensionOmpMcpCancelSmoke,
} from "../scripts/extension-omp-mcp-cancel-smoke.mjs";
import {
	classifyAgentToolExecuteSignalArg,
	hostExecuteToolOmitsAbortSignal,
} from "../scripts/lib/cursor-host-cancel-probe.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NODE_EXECUTABLE = process.env.NODE?.trim() || (process.platform === "win32" ? "node.exe" : "node");

function runNode(args: string[]) {
	return spawnSync(NODE_EXECUTABLE, args, { cwd: repoRoot, encoding: "utf8" });
}

describe("extension-omp-mcp-cancel-smoke", () => {
	it("detects open host cancel gap on installed OMP (3rd arg undefined)", () => {
		const probe = hostExecuteToolOmitsAbortSignal(repoRoot);
		expect(probe.gap).toBe(true);
		expect(probe.status).toBe("open");
		expect(probe.thirdArg).toBe("undefined");
	});

	it("builds blocked gate evidence by default", () => {
		const evidence = buildExtensionOmpMcpCancelEvidence();
		expect(evidence.lane).toBe("extension-omp-mcp-cancel");
		expect(evidence.hostCancelGapOpen).toBe(true);
		expect(evidence.status).toBe("blocked");
		expect(evidence.liveCancelRunnable).toBe(false);
		expect(evidence.proposalDoc).toBe("docs/omp-handlers-mcp-cancel-proposal.md");
	});

	it("does not treat unknown probe as live-runnable", () => {
		const evidence = buildExtensionOmpMcpCancelEvidence({
			status: "unknown",
			gap: null,
			thirdArg: null,
			path: "missing.ts",
		});
		expect(evidence.status).toBe("unknown");
		expect(evidence.liveCancelRunnable).toBe(false);
		expect(evidence.hostCancelGapOpen).toBe(false);
	});

	it("treats signal-like 3rd arg as source-wiring-observed, not gate pass", () => {
		const probe = classifyAgentToolExecuteSignalArg(
			`
async function executeTool() {
  await tool.execute(toolCallId, toolArgs, signal, onUpdate, ctx);
}
`,
			"fixture",
		);
		expect(probe.status).toBe("source-wiring-observed");
		expect(probe.gap).toBe(false);
		const evidence = buildExtensionOmpMcpCancelEvidence(probe);
		expect(evidence.status).toBe("source-wiring-observed");
		expect(evidence.liveCancelRunnable).toBe(true);
	});

	it("does not treat 5th-arg signal with onUpdate 3rd as wiring", () => {
		const probe = classifyAgentToolExecuteSignalArg(
			`
async function executeTool() {
  await tool.execute(toolCallId, toolArgs, onUpdate, ctx, signal);
}
`,
			"fifth-only",
		);
		expect(probe.status).toBe("unknown");
		expect(probe.gap).toBeNull();
	});

	it("does not treat comment or trailing audit(signal) as closed", () => {
		const commented = classifyAgentToolExecuteSignalArg(
			`
async function executeTool() {
  await tool.execute(toolCallId, toolArgs, undefined /* signal */, onUpdate, ctx);
}
`,
			"comment",
		);
		expect(commented.status).toBe("open");
		expect(commented.gap).toBe(true);

		const trailing = classifyAgentToolExecuteSignalArg(
			`
async function executeTool() {
  await tool.execute(toolCallId, toolArgs, undefined, onUpdate, ctx);
  audit(signal);
}
`,
			"trailing",
		);
		expect(trailing.status).toBe("open");
		expect(trailing.gap).toBe(true);
	});

	it("runs probe-only smoke without live auth", async () => {
		const evidence = await runExtensionOmpMcpCancelSmoke([]);
		expect(evidence.status).toBe("blocked");
		expect("liveCancelRunnable" in evidence && evidence.liveCancelRunnable).toBe(false);
	});

	it("self-test passes fixture matrix", () => {
		const result = runCancelProbeSelfTest();
		expect(result.ok).toBe(true);
		expect(result.caseCount).toBeGreaterThan(5);
	});

	it("self-test CLI passes on fixtures", () => {
		if (process.platform === "win32") return;
		const result = runNode(["scripts/extension-omp-mcp-cancel-smoke.mjs", "--self-test"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("self-test PASS");
	});

	it("rejects unknown CLI flags", () => {
		const result = runNode(["scripts/extension-omp-mcp-cancel-smoke.mjs", "--nope"]);
		expect(result.status).toBe(2);
	});
});

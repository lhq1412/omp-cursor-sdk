import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
// @ts-expect-error Maintainer Node ESM smoke script is intentionally untyped.
import { buildExtensionOmpMcpCancelEvidence, runExtensionOmpMcpCancelSmoke } from "../scripts/extension-omp-mcp-cancel-smoke.mjs";
// @ts-expect-error Maintainer Node ESM probe helper is intentionally untyped.
import { hostExecuteToolOmitsAbortSignal } from "../scripts/lib/cursor-host-cancel-probe.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NODE_EXECUTABLE = process.env.NODE?.trim() || (process.platform === "win32" ? "node.exe" : "node");

function runNode(args: string[]) {
	return spawnSync(NODE_EXECUTABLE, args, { cwd: repoRoot, encoding: "utf8" });
}

describe("extension-omp-mcp-cancel-smoke", () => {
	it("detects open host cancel gap on installed OMP", () => {
		const probe = hostExecuteToolOmitsAbortSignal(repoRoot);
		expect(probe.gap).toBe(true);
		expect(probe.status).toBe("open");
	});

	it("builds blocked gate evidence by default", () => {
		const evidence = buildExtensionOmpMcpCancelEvidence();
		expect(evidence.lane).toBe("extension-omp-mcp-cancel");
		expect(evidence.hostCancelGapOpen).toBe(true);
		expect(evidence.status).toBe("blocked");
		expect(evidence.proposalDoc).toBe("docs/omp-handlers-mcp-cancel-proposal.md");
	});

	it("runs probe-only smoke without live auth", async () => {
		const evidence = await runExtensionOmpMcpCancelSmoke([]);
		expect(evidence.status).toBe("blocked");
		expect(evidence.liveCancelRunnable).toBe(false);
	});

	it("self-test passes on current OMP host gap", () => {
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

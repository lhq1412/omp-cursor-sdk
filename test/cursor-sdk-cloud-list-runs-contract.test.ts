import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const sdkDist = join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm");
type ListedCloudRun = Awaited<ReturnType<typeof Agent.listRuns>>["items"][number];

function listedRunId(run: ListedCloudRun): string {
	return run.id;
}

describe("installed Cursor SDK cloud listRuns contract", () => {
	it("returns Run objects with exact IDs for cancel-lane recovery", () => {
		const declaration = readFileSync(join(sdkDist, "stubs.d.ts"), "utf8");
		expect(declaration).toMatch(/static listRuns\(agentId: string, options\?: ListRunsOptions\): Promise<ListResult<Run>>/);

		const sdkBundles = readdirSync(sdkDist, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
			.map((entry) => readFileSync(join(sdkDist, entry.name), "utf8"));
		expect(sdkBundles.some((source) => source.includes("listCloudRuns"))).toBe(true);
		const bundledSource = sdkBundles.join("\n");
		expect(/\.listRuns\(t,\{limit:e\.limit,cursor:e\.cursor\}\)/.test(bundledSource)).toBe(true);
		expect(/items:\w+\.items\.map\(\(t=>new \w+\(\w+,t\)\)\)/.test(bundledSource)).toBe(true);

		expect(listedRunId({ id: "run-00000000-0000-0000-0000-000000000001" } as ListedCloudRun)).toBe(
			"run-00000000-0000-0000-0000-000000000001",
		);
	});
});

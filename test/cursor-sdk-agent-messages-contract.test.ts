import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";

const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
const installedSdkVersion = readInstalledPackageVersion("@cursor/sdk");

describe("installed Cursor SDK 1.0.30 agent messages contract", () => {
	it("paginates checkpoint turns by ascending offset without a total count", () => {
		expect(installedSdkVersion).toBe("1.0.30");

		const agentTypes = readFileSync(join(sdkRoot, "dist/esm/agent.d.ts"), "utf8");
		const options = agentTypes.match(/export interface GetAgentMessagesOptions \{([\s\S]*?)\n\}/)?.[1];
		expect(options).toContain("limit?: number;");
		expect(options).toContain("offset?: number;");
		expect(options).not.toMatch(/\b(?:count|cursor|nextCursor|total)\b/);

		const stubs = readFileSync(join(sdkRoot, "dist/esm/stubs.d.ts"), "utf8");
		expect(stubs).toContain("list(agentId: string, options?: GetAgentMessagesOptions): Promise<AgentMessage[]>");

		const runtime = readFileSync(join(sdkRoot, "dist/esm/index.js"), "utf8");
		expect(runtime).toContain("(yield this.checkpointStore.getFullConversation(e)).turns");
		expect(runtime).toContain(
			"const s=null!==(n=null==t?void 0:t.offset)&&void 0!==n?n:0,o=(null==t?void 0:t.limit)?s+t.limit:void 0;return r.slice(s,o).map",
		);
	});

	it("still omits WebSearch and WebFetch from public onDelta/onStep schemas", () => {
		const agentTypes = readFileSync(join(sdkRoot, "dist/esm/agent.d.ts"), "utf8");
		expect(agentTypes).toContain("step: ConversationStep;");
		expect(agentTypes).toContain("update: InteractionUpdate;");

		const publicEventTypes = [
			"dist/esm/vendor/cursor-sdk-shared/delta-types.d.ts",
			"dist/esm/types/conversation-types.d.ts",
		]
			.map((path) => readFileSync(join(sdkRoot, path), "utf8"))
			.join("\n");

		expect(publicEventTypes).not.toMatch(/WebSearch|WebFetch/);
	});
});

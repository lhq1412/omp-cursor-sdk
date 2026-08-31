import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	version: string;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	bundledDependencies?: string[];
	overrides?: Record<string, string>;
};
const packageLock = require("../package-lock.json") as {
	version: string;
	packages: Record<string, {
		version?: string;
		resolved?: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		bundleDependencies?: boolean | string[];
		inBundle?: boolean;
	}>;
};
type BunLockHeader = {
	workspaces: Record<string, {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	}>;
};

function readBunLock(): BunLockHeader {
	const parsed = parseConfigFileTextToJson("bun.lock", readFileSync(join(process.cwd(), "bun.lock"), "utf8"));
	if (parsed.error) throw new Error("bun.lock is not valid JSONC");
	return parsed.config as BunLockHeader;
}

function lockPackageVersion(packageName: string): string | undefined {
	return packageLock.packages[`node_modules/${packageName}`]?.version;
}

describe("package metadata cutover baselines", () => {
	it("keeps package, lockfile, and changelog release versions aligned", () => {
		const changelogVersion = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8").match(/^## (\S+) /m)?.[1];

		expect(packageLock.version).toBe(packageJson.version);
		expect(packageLock.packages[""]?.version).toBe(packageJson.version);
		expect(changelogVersion).toBe(packageJson.version);
	});

	it("pins Cursor SDK exactly", () => {
		expect(packageJson.dependencies["@cursor/sdk"]).toBe("1.0.27");
		expect(lockPackageVersion("@cursor/sdk")).toBe("1.0.27");
	});

	it("keeps Bun and npm direct dependency specs aligned with package metadata", () => {
		const bunLock = readBunLock();
		for (const group of ["dependencies", "devDependencies"] as const) {
			expect(packageLock.packages[""]?.[group]).toEqual(packageJson[group]);
			expect(bunLock.workspaces[""]?.[group]).toEqual(packageJson[group]);
		}
		for (const [packageName, version] of Object.entries(packageJson.dependencies)
			.filter(([name]) => name === "@cursor/sdk" || name.startsWith("@oh-my-pi/"))) {
			expect(lockPackageVersion(packageName)).toBe(version);
		}
	});

	it("keeps lockfile resolved URLs on the public npm registry", () => {
		const hosts = new Set(
			Object.values(packageLock.packages)
				.flatMap((entry) => (entry.resolved ? [new URL(entry.resolved).host] : [])),
		);
		expect([...hosts]).toEqual(["registry.npmjs.org"]);
	});

	it("pins MCP/Hono as exact ordinary dependencies without bundle metadata", () => {
		for (const [packageName, version] of [
			["@modelcontextprotocol/sdk", "1.30.0"],
			["@hono/node-server", "2.0.12"],
		] as const) {
			expect(packageJson.dependencies[packageName]).toBe(version);
			expect(packageLock.packages[""]?.dependencies?.[packageName]).toBe(version);
			expect(lockPackageVersion(packageName)).toBe(version);
		}
		expect(packageJson.bundledDependencies).toBeUndefined();
		expect(packageLock.packages[""]?.bundleDependencies).toBeUndefined();
		expect(Object.values(packageLock.packages).some((entry) => entry.inBundle)).toBe(false);
	});

	it("keeps local agent ID policy aligned with the installed public string contract", () => {
		const sdkOptions = readFileSync(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/options.d.ts"), "utf8");

		expect(sdkOptions).toMatch(/export interface AgentOptions[\s\S]*?\bagentId\?: string;/);
	});

	it("pins the Node ConnectRPC transport required by Cursor SDK's Node seam", () => {
		const sdkTransportDts = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/transport.d.ts"),
			"utf8",
		);

		expect(sdkTransportDts).toContain("Node");
		expect(sdkTransportDts).toContain("`@connectrpc/connect-node`");
		expect(packageLock.packages["node_modules/@cursor/sdk"]?.dependencies?.["@connectrpc/connect-node"]).toBe("^1.6.1");
		expect(packageJson.dependencies["@connectrpc/connect-node"]).toBeUndefined();
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe("1.7.0");
	});

	it("keeps installed ConnectRPC transport siblings aligned", () => {
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe("1.7.0");
		expect(lockPackageVersion("@connectrpc/connect-web")).toBe("1.7.0");
	});

	it("leaves the Cursor SDK transport dependency tree to npm resolution", () => {
		expect(packageJson.dependencies.undici).toBeUndefined();
		expect(packageJson.overrides).toBeUndefined();
		expect(packageLock.packages["node_modules/@connectrpc/connect-node/node_modules/undici"]?.version).toBe("5.29.0");
	});

	it("removes the obsolete sqlite override", () => {
		expect(packageJson.overrides).toBeUndefined();
	});

	it("tracks OMP openai-codex GPT-5.6 metadata", () => {
		for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
			expect(getBundledModel("openai-codex", modelId)).toMatchObject({
				contextWindow: 1000000,
				maxTokens: 128000,
			});
		}
	});

	it("keeps Grok UX examples aligned with the generated Cursor catalog", () => {
		const spec = readFileSync(join(process.cwd(), "docs/cursor-model-ux-spec.md"), "utf8");
		const grok45 = FALLBACK_MODEL_ITEMS.find((item) => item.id === "grok-4.5");
		const grok46 = FALLBACK_MODEL_ITEMS.find((item) => item.id === "grok-4.6");

		expect(grok45?.parameters?.map((parameter) => parameter.id)).toEqual(["effort", "fast"]);
		expect(grok46?.parameters?.map((parameter) => parameter.id)).toEqual(["effort", "fast"]);
		expect(grok46?.parameters?.find((parameter) => parameter.id === "effort")?.values?.map((value) => value.value)).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(FALLBACK_MODEL_ITEMS.some((item) => item.id === "grok-4.3")).toBe(false);
		expect(spec).toContain("### `grok-4.5`");
		expect(spec).toContain("### `grok-4.6`");
		expect(spec).not.toContain("grok-4.3");
	});

});

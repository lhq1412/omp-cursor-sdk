import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolvePiCodingAgentCursorSource(repoRoot) {
	return join(repoRoot, "node_modules/@oh-my-pi/pi-coding-agent/src/cursor.ts");
}

export function resolveInstalledHostPackageVersion(repoRoot) {
	const packageJsonPath = join(repoRoot, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
	if (!existsSync(packageJsonPath)) {
		return "unknown";
	}
	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		return packageJson.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Contract probe: OMP CursorExecBridge.executeTool still omits run-scoped AbortSignal.
 * Returns gap=true when executeTool passes undefined onUpdate and no signal wiring.
 */
export function hostExecuteToolOmitsAbortSignal(repoRoot) {
	const sourcePath = resolvePiCodingAgentCursorSource(repoRoot);
	if (!existsSync(sourcePath)) {
		return { status: "unknown", gap: null, path: sourcePath };
	}
	const source = readFileSync(sourcePath, "utf8");
	const start = source.indexOf("async function executeTool");
	if (start === -1) {
		return { status: "unknown", gap: null, path: sourcePath };
	}
	const slice = source.slice(start, start + 3200);
	const executeCall = slice.match(/await tool\.execute\([\s\S]{0,400}\)/);
	if (!executeCall) {
		return { status: "unknown", gap: null, path: sourcePath };
	}
	const passesSignal = /\bsignal\b/.test(executeCall[0]);
	const gap = !passesSignal;
	return { status: gap ? "open" : "closed", gap, path: sourcePath };
}

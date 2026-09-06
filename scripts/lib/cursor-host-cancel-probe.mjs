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
 * Split a call-argument list on top-level commas (ignores commas inside
 * nested (), [], {}, and strings/template literals).
 */
export function splitTopLevelArgs(argsText) {
	const args = [];
	let depthParen = 0;
	let depthBracket = 0;
	let depthBrace = 0;
	let depthAngle = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i < argsText.length; i++) {
		const ch = argsText[i];
		const prev = i > 0 ? argsText[i - 1] : "";
		if (quote) {
			if (ch === quote && prev !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		// TypeScript type args: Record<string, unknown> must not split on inner commas.
		if (ch === "<") depthAngle++;
		else if (ch === ">" && depthAngle > 0) depthAngle--;
		else if (ch === "(") depthParen++;
		else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
		else if (ch === "[") depthBracket++;
		else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
		else if (ch === "{") depthBrace++;
		else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
		else if (
			ch === "," &&
			depthParen === 0 &&
			depthBracket === 0 &&
			depthBrace === 0 &&
			depthAngle === 0
		) {
			args.push(argsText.slice(start, i).trim());
			start = i + 1;
		}
	}
	const tail = argsText.slice(start).trim();
	if (tail) args.push(tail);
	return args;
}

/**
 * Extract the first `tool.execute(...)` argument list inside `executeTool`.
 * Returns null when the call shape cannot be recognized.
 */
export function extractToolExecuteArgsList(executeToolSource) {
	const callMatch = executeToolSource.match(/\btool\.execute\s*\(/);
	if (!callMatch || callMatch.index === undefined) return null;
	const open = callMatch.index + callMatch[0].length - 1;
	let depth = 0;
	let quote = null;
	for (let i = open; i < executeToolSource.length; i++) {
		const ch = executeToolSource[i];
		const prev = i > 0 ? executeToolSource[i - 1] : "";
		if (quote) {
			if (ch === quote && prev !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) {
				return executeToolSource.slice(open + 1, i);
			}
		}
	}
	return null;
}

/** Strip line/block comments from a single argument expression. */
export function stripArgComments(expr) {
	return expr
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.trim();
}

/**
 * Classify AgentTool execute 3rd-parameter wiring.
 * AgentToolExecFn: (toolCallId, params, signal?, onUpdate?, context?)
 *
 * @returns {{ status: string, gap: boolean | null, thirdArg: string | null, path?: string }}
 */
export function classifyAgentToolExecuteSignalArg(sourceText, sourcePath = "") {
	if (typeof sourceText !== "string" || !sourceText.includes("async function executeTool")) {
		return { status: "unknown", gap: null, thirdArg: null, path: sourcePath };
	}
	const start = sourceText.indexOf("async function executeTool");
	const slice = sourceText.slice(start, start + 6000);
	const argsText = extractToolExecuteArgsList(slice);
	if (argsText === null) {
		return { status: "unknown", gap: null, thirdArg: null, path: sourcePath };
	}
	const args = splitTopLevelArgs(argsText).map(stripArgComments);
	if (args.length < 3) {
		return { status: "unknown", gap: null, thirdArg: null, path: sourcePath };
	}
	const thirdArg = args[2];
	// Explicit hole: current OMP 18.1.x cursor.ts passes `undefined` as signal.
	if (thirdArg === "undefined") {
		return { status: "open", gap: true, thirdArg, path: sourcePath };
	}
	// Suspected AbortSignal expression in the AgentTool signal slot (3rd).
	// Not proof of runtime cancel safety — only source wiring observed.
	if (
		/^(?:signal|abortSignal|abortToken|combinedSignal|runSignal|controller\.signal)$/.test(thirdArg) ||
		/\.signal\b/.test(thirdArg) ||
		/\bAbortSignal\b/.test(thirdArg)
	) {
		return { status: "source-wiring-observed", gap: false, thirdArg, path: sourcePath };
	}
	// Anything else (wrong slot filled with onUpdate, odd expressions, …)
	return { status: "unknown", gap: null, thirdArg, path: sourcePath };
}

/**
 * Contract probe against installed OMP CursorExecBridge.executeTool.
 * Conservative: never treats missing/unparsed source as "gap closed".
 */
export function hostExecuteToolOmitsAbortSignal(repoRoot) {
	const sourcePath = resolvePiCodingAgentCursorSource(repoRoot);
	if (!existsSync(sourcePath)) {
		return { status: "unknown", gap: null, thirdArg: null, path: sourcePath };
	}
	let source;
	try {
		source = readFileSync(sourcePath, "utf8");
	} catch {
		return { status: "unknown", gap: null, thirdArg: null, path: sourcePath };
	}
	return classifyAgentToolExecuteSignalArg(source, sourcePath);
}

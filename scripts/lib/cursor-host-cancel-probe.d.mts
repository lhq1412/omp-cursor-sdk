export function resolvePiCodingAgentCursorSource(repoRoot: string): string;
export function resolveInstalledHostPackageVersion(repoRoot: string): string;
export function splitTopLevelArgs(argsText: string): string[];
export function extractToolExecuteArgsList(executeToolSource: string): string | null;
export function stripArgComments(expr: string): string;
export function classifyAgentToolExecuteSignalArg(
	sourceText: string,
	sourcePath?: string,
): {
	status: string;
	gap: boolean | null;
	thirdArg: string | null;
	path?: string;
};
export function hostExecuteToolOmitsAbortSignal(repoRoot: string): {
	status: string;
	gap: boolean | null;
	thirdArg: string | null;
	path?: string;
};

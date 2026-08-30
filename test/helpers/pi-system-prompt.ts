import {
	OMP_REPO_RULES_CLOSE,
	OMP_REPO_RULES_OPEN,
	type OmpRepoRuleFile,
} from "../../src/cursor-agents-context.js";

export function serializeOmpRepoRuleFile(file: OmpRepoRuleFile): string {
	return `<file path="${file.path}">\n${file.content}\n</file>`;
}

export function serializeOmpRepoRulesSection(contextFiles: readonly OmpRepoRuleFile[]): string {
	if (contextFiles.length === 0) return "";
	return [
		OMP_REPO_RULES_OPEN,
		"MUST follow these context files for all tasks:",
		...contextFiles.map(serializeOmpRepoRuleFile),
		OMP_REPO_RULES_CLOSE,
	].join("\n");
}

export function buildOmpSystemPromptWithContextFiles(
	contextFiles: readonly OmpRepoRuleFile[],
	cwd = "/repo",
): string {
	return [
		"You are an expert coding assistant operating inside OMP.",
		serializeOmpRepoRulesSection(contextFiles),
		`Current working directory: ${cwd}`,
	].filter(Boolean).join("\n\n");
}

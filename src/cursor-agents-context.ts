import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SettingSource } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { isCursorModel } from "./cursor-model.js";
import {
	cursorSettingSourcesIncludes,
	getEffectiveCursorSettingSources,
	resolveCursorSettingSources,
} from "./cursor-setting-sources.js";

export const CURSOR_PRESERVE_PI_AGENTS_MD_ENV = "PI_CURSOR_PRESERVE_PI_AGENTS_MD";
export const OMP_REPO_RULES_OPEN = "<repo-rules>";
export const OMP_REPO_RULES_CLOSE = "</repo-rules>";
export const OMP_REPO_RULE_FILE_OPEN_PREFIX = '<file path="';
const OMP_REPO_RULE_FILE_PATTERN = /^<file path="([^"\n]+)">\n[\s\S]*?^<\/file>$/gm;
const OMP_REPO_RULE_FILE_OPEN_PATTERN = /^<file path="[^"\n]+">$/gm;
const OMP_REPO_RULE_FILE_CLOSE_PATTERN = /^<\/file>$/gm;

function normalizeContextPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function normalizeDirPath(dirPath: string): string {
	return normalizeContextPath(dirPath).replace(/\/+$/, "");
}

export interface OmpRepoRuleFile {
	path: string;
	content: string;
}

export type OmpAgentsContextOverlap = "none" | "cursor-user-agents" | "cursor-project-rules";
const CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES = new Set(["agents.md", "claude.md"]);

export function getAgentsContextFileBaseName(filePath: string): string {
	const normalized = normalizeContextPath(filePath);
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isOmpAgentDirContextFilePath(
	filePath: string,
	fileName: "agents.md" | "claude.md",
	agentDir: string = getAgentDir(),
): boolean {
	const normalizedPath = normalizeContextPath(filePath);
	const normalizedAgentDir = normalizeDirPath(agentDir);
	return normalizedPath.toLowerCase() === `${normalizedAgentDir}/${fileName}`.toLowerCase();
}

export function isPiAgentDirAgentsMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	return isOmpAgentDirContextFilePath(filePath, "agents.md", agentDir);
}

export function isPiAgentDirClaudeMdPath(filePath: string, agentDir: string = getAgentDir()): boolean {
	return isOmpAgentDirContextFilePath(filePath, "claude.md", agentDir);
}

export function classifyContextFileOverlap(
	filePath: string,
	agentDir: string = getAgentDir(),
): OmpAgentsContextOverlap {
	const baseName = getAgentsContextFileBaseName(filePath);
	if (!CURSOR_OVERLAPPING_CONTEXT_BASE_NAMES.has(baseName)) return "none";
	if (isPiAgentDirAgentsMdPath(filePath, agentDir)) return "cursor-user-agents";
	if (isPiAgentDirClaudeMdPath(filePath, agentDir)) return "none";
	return "cursor-project-rules";
}

export function shouldRemoveOmpRepoRuleFile(
	filePath: string,
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): boolean {
	switch (classifyContextFileOverlap(filePath, agentDir)) {
		case "cursor-user-agents":
			return cursorSettingSourcesIncludes(settingSources, "user");
		case "cursor-project-rules":
			return cursorSettingSourcesIncludes(settingSources, "project");
		case "none":
			return false;
	}
}

function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

interface OmpRepoRuleFileBlock {
	path: string;
	start: number;
	end: number;
}

function parseOmpRepoRuleFileBlocks(section: string): OmpRepoRuleFileBlock[] | undefined {
	const openCount = section.match(OMP_REPO_RULE_FILE_OPEN_PATTERN)?.length ?? 0;
	const closeCount = section.match(OMP_REPO_RULE_FILE_CLOSE_PATTERN)?.length ?? 0;
	if (openCount === 0 || openCount !== closeCount) return undefined;

	const blocks: OmpRepoRuleFileBlock[] = [];
	for (const match of section.matchAll(OMP_REPO_RULE_FILE_PATTERN)) {
		const encodedPath = match[1];
		if (encodedPath === undefined || match.index === undefined) return undefined;
		blocks.push({
			path: decodeXmlAttribute(encodedPath),
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return blocks.length === openCount ? blocks : undefined;
}

export function removeOmpAgentsContextFromSystemPromptPart(
	systemPromptPart: string,
	settingSources: SettingSource[] | undefined,
	agentDir?: string,
): string {
	const sectionStart = systemPromptPart.indexOf(OMP_REPO_RULES_OPEN);
	if (sectionStart < 0) return systemPromptPart;
	const closeStart = systemPromptPart.indexOf(OMP_REPO_RULES_CLOSE, sectionStart + OMP_REPO_RULES_OPEN.length);
	if (closeStart < 0) return systemPromptPart;
	const sectionEnd = closeStart + OMP_REPO_RULES_CLOSE.length;
	const section = systemPromptPart.slice(sectionStart, sectionEnd);
	const blocks = parseOmpRepoRuleFileBlocks(section);
	if (!blocks) return systemPromptPart;

	const removed = blocks.filter((block) => shouldRemoveOmpRepoRuleFile(block.path, settingSources, agentDir));
	if (removed.length === 0) return systemPromptPart;
	if (removed.length === blocks.length) {
		return systemPromptPart.slice(0, sectionStart) + systemPromptPart.slice(sectionEnd);
	}

	let cursor = 0;
	let replacement = "";
	for (const block of removed) {
		replacement += section.slice(cursor, block.start);
		cursor = block.end;
	}
	replacement += section.slice(cursor);
	return systemPromptPart.slice(0, sectionStart) + replacement + systemPromptPart.slice(sectionEnd);
}

export function resolveCursorFacingSystemPromptParts(
	systemPrompt: string[],
	model: ExtensionContext["model"],
	settingSourcesRaw?: string,
	agentDir?: string,
	runtime: CursorRuntime = "local",
): string[] {
	if (runtime === "cloud" || !isCursorModel(model)) return systemPrompt;
	if (parseEnvBoolean(process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV], false)) return systemPrompt;
	const settingSources = settingSourcesRaw === undefined
		? getEffectiveCursorSettingSources()
		: resolveCursorSettingSources(settingSourcesRaw);
	const resolved = systemPrompt.map((part) => removeOmpAgentsContextFromSystemPromptPart(part, settingSources, agentDir));
	return resolved.some((part, index) => part !== systemPrompt[index]) ? resolved : systemPrompt;
}

import { beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	classifyContextFileOverlap,
	CURSOR_PRESERVE_PI_AGENTS_MD_ENV,
	getAgentsContextFileBaseName,
	isPiAgentDirAgentsMdPath,
	OMP_REPO_RULE_FILE_OPEN_PREFIX,
	removeOmpAgentsContextFromSystemPromptPart,
	resolveCursorFacingSystemPromptParts,
	shouldRemoveOmpRepoRuleFile,
} from "../src/cursor-agents-context.js";
import { registerCursorAgentsContextDedup } from "../src/cursor-agents-context-registration.js";
import { buildCursorPrompt } from "../src/context.js";
import { CURSOR_SETTING_SOURCES_ENV } from "../src/cursor-setting-sources.js";
import { createEventHarness, makeHarnessModel, makeModel } from "./helpers/pi-harness.js";
import {
	buildOmpSystemPromptWithContextFiles,
	serializeOmpRepoRuleFile,
	serializeOmpRepoRulesSection,
} from "./helpers/pi-system-prompt.js";

const DEFAULT_AGENT_DIR = "/Users/me/.omp/agent";
const CUSTOM_AGENT_DIR = "/custom/omp-agent";
const GLOBAL_AGENTS_PATH = `${DEFAULT_AGENT_DIR}/AGENTS.md`;
const GLOBAL_CLAUDE_PATH = `${DEFAULT_AGENT_DIR}/CLAUDE.md`;
const PROJECT_AGENTS_PATH = "/repo/AGENTS.md";
const PROJECT_CLAUDE_PATH = "/repo/CLAUDE.md";
const NESTED_UNDER_AGENT_AGENTS_PATH = `${DEFAULT_AGENT_DIR}/my-project/AGENTS.md`;
const NESTED_UNDER_AGENT_CLAUDE_PATH = `${DEFAULT_AGENT_DIR}/my-project/CLAUDE.md`;

const GLOBAL_FILE = { path: GLOBAL_AGENTS_PATH, content: "Global guidance" };
const GLOBAL_CLAUDE_FILE = { path: GLOBAL_CLAUDE_PATH, content: "Global claude guidance" };
const PROJECT_FILE = { path: PROJECT_AGENTS_PATH, content: "Project guidance" };
const PROJECT_CLAUDE_FILE = { path: PROJECT_CLAUDE_PATH, content: "Project claude guidance" };

beforeEach(() => {
	delete process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV];
	delete process.env[CURSOR_SETTING_SOURCES_ENV];
	delete process.env.PI_CURSOR_RUNTIME;
});

describe("classifyContextFileOverlap", () => {
	it("maps OMP AGENTS.md and project rules to Cursor setting-source layers", () => {
		expect(classifyContextFileOverlap(GLOBAL_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-user-agents");
		expect(classifyContextFileOverlap(PROJECT_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(PROJECT_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(GLOBAL_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("none");
		expect(getAgentsContextFileBaseName("/repo/AGENTS.MD")).toBe("agents.md");
		expect(isPiAgentDirAgentsMdPath(GLOBAL_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe(true);
		expect(isPiAgentDirAgentsMdPath(PROJECT_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe(false);
	});

	it("uses the actual agent directory instead of matching arbitrary path segments", () => {
		const customAgentsPath = `${CUSTOM_AGENT_DIR}/AGENTS.md`;
		const customClaudePath = `${CUSTOM_AGENT_DIR}/CLAUDE.md`;
		const nestedCustomAgentsPath = `${CUSTOM_AGENT_DIR}/projects/foo/AGENTS.md`;

		expect(classifyContextFileOverlap(customAgentsPath, CUSTOM_AGENT_DIR)).toBe("cursor-user-agents");
		expect(classifyContextFileOverlap(customClaudePath, CUSTOM_AGENT_DIR)).toBe("none");
		expect(classifyContextFileOverlap(nestedCustomAgentsPath, CUSTOM_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(GLOBAL_AGENTS_PATH, CUSTOM_AGENT_DIR)).toBe("cursor-project-rules");
	});

	it("treats nested AGENTS.md and CLAUDE.md files as project rules", () => {
		expect(classifyContextFileOverlap(NESTED_UNDER_AGENT_AGENTS_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
		expect(classifyContextFileOverlap(NESTED_UNDER_AGENT_CLAUDE_PATH, DEFAULT_AGENT_DIR)).toBe("cursor-project-rules");
	});
});

describe("OMP repo-rules serialization and removal", () => {
	it("matches OMP 18's repo-rules file shape", () => {
		expect(serializeOmpRepoRuleFile(PROJECT_FILE)).toBe(
			'<file path="/repo/AGENTS.md">\nProject guidance\n</file>',
		);
		expect(serializeOmpRepoRulesSection([PROJECT_FILE])).toBe(
			'<repo-rules>\nMUST follow these context files for all tasks:\n<file path="/repo/AGENTS.md">\nProject guidance\n</file>\n</repo-rules>',
		);
		expect(OMP_REPO_RULE_FILE_OPEN_PREFIX).toBe('<file path="');
	});

	it("removes only files whose Cursor setting source will reload them", () => {
		expect(shouldRemoveOmpRepoRuleFile(GLOBAL_AGENTS_PATH, ["all"], DEFAULT_AGENT_DIR)).toBe(true);
		expect(shouldRemoveOmpRepoRuleFile(PROJECT_AGENTS_PATH, ["project"], DEFAULT_AGENT_DIR)).toBe(true);
		expect(shouldRemoveOmpRepoRuleFile(PROJECT_CLAUDE_PATH, ["user"], DEFAULT_AGENT_DIR)).toBe(false);
		expect(shouldRemoveOmpRepoRuleFile(GLOBAL_CLAUDE_PATH, ["all"], DEFAULT_AGENT_DIR)).toBe(false);
	});

	it("removes a fully overlapping repo-rules section", () => {
		const prompt = buildOmpSystemPromptWithContextFiles([PROJECT_FILE, PROJECT_CLAUDE_FILE]);
		const stripped = removeOmpAgentsContextFromSystemPromptPart(prompt, ["all"], DEFAULT_AGENT_DIR);

		expect(stripped).not.toContain("Project guidance");
		expect(stripped).not.toContain("Project claude guidance");
		expect(stripped).not.toContain("<repo-rules>");
	});

	it("retains non-overlapping files while removing project AGENTS.md", () => {
		const customFile = { path: "/repo/CUSTOM.md", content: "Custom guidance" };
		const prompt = buildOmpSystemPromptWithContextFiles([PROJECT_FILE, customFile]);
		const stripped = removeOmpAgentsContextFromSystemPromptPart(prompt, ["project"], DEFAULT_AGENT_DIR);

		expect(stripped).not.toContain("Project guidance");
		expect(stripped).toContain("Custom guidance");
		expect(stripped).toContain("<repo-rules>");
	});

	it("fails closed when rule content makes the OMP file markup ambiguous", () => {
		const closeTagContent = buildOmpSystemPromptWithContextFiles([
			{ path: PROJECT_AGENTS_PATH, content: "Document this literal line:\n</file>\nwithout treating it as markup." },
		]);
		const nestedOpenContent = buildOmpSystemPromptWithContextFiles([
			{ path: PROJECT_AGENTS_PATH, content: '<file path="literal">\nnot a real context file' },
		]);

		expect(removeOmpAgentsContextFromSystemPromptPart(closeTagContent, ["all"], DEFAULT_AGENT_DIR)).toBe(closeTagContent);
		expect(removeOmpAgentsContextFromSystemPromptPart(nestedOpenContent, ["all"], DEFAULT_AGENT_DIR)).toBe(nestedOpenContent);
	});
});

describe("resolveCursorFacingSystemPromptParts", () => {
	const cursorSdkModel = makeModel("composer-2.5");
	const builtinCursorModel = makeHarnessModel("cursor", "openai-completions", "gpt-5.6");
	const apiOnlyModel = makeHarnessModel("other", "cursor-sdk", "composer-2.5");
	const otherModel = makeHarnessModel("anthropic", "anthropic-messages", "claude-sonnet-4-5");

	it("deduplicates only the independent cursor-sdk provider", () => {
		const projectPart = buildOmpSystemPromptWithContextFiles([PROJECT_FILE]);
		const prompt = ["base", projectPart, "tail"];
		const resolved = resolveCursorFacingSystemPromptParts(prompt, cursorSdkModel, "all", DEFAULT_AGENT_DIR);

		expect(resolved).toEqual(["base", expect.not.stringContaining("Project guidance"), "tail"]);
		expect(resolveCursorFacingSystemPromptParts(prompt, builtinCursorModel, "all", DEFAULT_AGENT_DIR)).toBe(prompt);
		expect(resolveCursorFacingSystemPromptParts(prompt, apiOnlyModel, "all", DEFAULT_AGENT_DIR)).toBe(prompt);
		expect(resolveCursorFacingSystemPromptParts(prompt, otherModel, "all", DEFAULT_AGENT_DIR)).toBe(prompt);
	});

	it("leaves prompts unchanged when no Cursor layer replaces them", () => {
		const prompt = [buildOmpSystemPromptWithContextFiles([PROJECT_FILE])];

		expect(resolveCursorFacingSystemPromptParts(prompt, cursorSdkModel, undefined, DEFAULT_AGENT_DIR)).toBe(prompt);
		expect(resolveCursorFacingSystemPromptParts(prompt, cursorSdkModel, "none", DEFAULT_AGENT_DIR)).toBe(prompt);
		expect(resolveCursorFacingSystemPromptParts(prompt, cursorSdkModel, "plugins,user", DEFAULT_AGENT_DIR)).toBe(prompt);
		expect(resolveCursorFacingSystemPromptParts(prompt, cursorSdkModel, "all", DEFAULT_AGENT_DIR, "cloud")).toBe(prompt);
	});

	it("honors PI_CURSOR_PRESERVE_PI_AGENTS_MD", () => {
		process.env[CURSOR_PRESERVE_PI_AGENTS_MD_ENV] = "1";
		const prompt = [buildOmpSystemPromptWithContextFiles([PROJECT_FILE])];

		expect(resolveCursorFacingSystemPromptParts(prompt, cursorSdkModel, "all", DEFAULT_AGENT_DIR)).toBe(prompt);
	});
});

describe("registerCursorAgentsContextDedup", () => {
	it("preserves OMP repo-rules when setting sources are unset", async () => {
		const projectPart = buildOmpSystemPromptWithContextFiles([PROJECT_FILE]);
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);

		expect(await pi.invokeEvent(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hello", systemPrompt: [projectPart] },
			{ model: makeModel("composer-2.5") },
		)).toBeUndefined();
	});

	it("rewrites OMP system-prompt blocks in place for cursor-sdk", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "all";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);
		const projectPart = buildOmpSystemPromptWithContextFiles([PROJECT_FILE]);

		const result = await pi.invokeEvent(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hello", systemPrompt: ["base", projectPart, "tail"] },
			{ model: makeModel("composer-2.5") },
		);

		expect(result?.systemPrompt).toEqual(["base", expect.not.stringContaining("Project guidance"), "tail"]);
	});

	it("preserves project instructions in cloud runtime and for non-cursor models", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "all";
		const projectPart = buildOmpSystemPromptWithContextFiles([PROJECT_FILE]);
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);

		process.env.PI_CURSOR_RUNTIME = "cloud";
		expect(await pi.invokeEvent(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hello", systemPrompt: [projectPart] },
			{ model: makeModel("composer-2.5") },
		)).toBeUndefined();

		delete process.env.PI_CURSOR_RUNTIME;
		expect(await pi.invokeEvent(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hello", systemPrompt: [projectPart] },
			{ model: makeHarnessModel("anthropic", "anthropic-messages", "claude-sonnet-4-5") },
		)).toBeUndefined();
	});

	it("feeds the deduplicated block array into the Cursor provider prompt", async () => {
		process.env[CURSOR_SETTING_SOURCES_ENV] = "all";
		const pi = createEventHarness();
		registerCursorAgentsContextDedup(pi);
		const projectPart = buildOmpSystemPromptWithContextFiles([PROJECT_FILE]);
		const hookResult = await pi.invokeEvent(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hello", systemPrompt: [projectPart] },
			{ model: makeModel("composer-2.5") },
		);
		const context: Context = {
			systemPrompt: hookResult?.systemPrompt ?? [projectPart],
			messages: [],
		};

		const result = buildCursorPrompt(context);
		expect(result.text).not.toContain("Project guidance");
		expect(result.text).not.toContain("<repo-rules>");
	});
});

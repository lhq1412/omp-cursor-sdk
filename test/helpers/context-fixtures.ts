import { createRequire } from "node:module";
import { vi } from "vitest";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@oh-my-pi/pi-ai";
import { ModelRegistry, type BuildSystemPromptOptions, type ExtensionCommandContext, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { makeModel } from "./model-fixtures.js";
import type { ExtensionCommandContextOverrides, ExtensionContextOverrides } from "./pi-harness-types.js";

const require = createRequire(import.meta.url);
type SqliteDatabase = ConstructorParameters<typeof SqliteAuthCredentialStore>[0];
const { Database } = require("bun:sqlite") as { Database: new (filename: string) => SqliteDatabase };
const sharedTestModelRegistry = new ModelRegistry(
	new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:"))),
	undefined,
	{ ignoreLocalModelConfig: true },
);

function getSharedTestModelRegistry(): ModelRegistry {
	return sharedTestModelRegistry;
}

export function createDefaultSystemPromptOptions(cwd: string): BuildSystemPromptOptions {
	return { cwd };
}

function createMinimalSessionManager(cwd: string, overrides: Partial<ExtensionContext["sessionManager"]> = {}): ExtensionContext["sessionManager"] {
	return {
		getCwd: vi.fn(() => cwd),
		getRecordedCwd: vi.fn(() => cwd),
		getSessionDir: vi.fn(() => ""),
		getSessionId: vi.fn(() => "test-session"),
		getSessionFile: vi.fn(() => undefined),
		getSessionName: vi.fn(() => undefined),
		getArtifactsDir: vi.fn(() => null),
		getArtifactManager: vi.fn(() => null),
		allocateArtifactPath: vi.fn(async () => ({})),
		saveArtifact: vi.fn(async () => undefined),
		getArtifactPath: vi.fn(async () => null),
		getLeafId: vi.fn(() => null),
		getLeafEntry: vi.fn(() => undefined),
		getEntry: vi.fn(() => undefined),
		getLabel: vi.fn(() => undefined),
		getBranch: vi.fn(() => []),
		getHeader: vi.fn(() => null),
		getEntries: vi.fn(() => []),
		getTree: vi.fn(() => []),
		getUsageStatistics: vi.fn() as ExtensionContext["sessionManager"]["getUsageStatistics"],
		putBlob: vi.fn() as ExtensionContext["sessionManager"]["putBlob"],
		putBlobSync: vi.fn() as ExtensionContext["sessionManager"]["putBlobSync"],
		...overrides,
	};
}

function createMinimalExtensionUi(): ExtensionContext["ui"] {
	return {
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => false),
		input: vi.fn(async () => undefined),
		notify: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader: vi.fn(),
		setTitle: vi.fn(),
		custom: vi.fn(<T>() => Promise.resolve(undefined as T)) as ExtensionContext["ui"]["custom"],
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
		editor: vi.fn(async () => undefined),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		theme: {} as ExtensionContext["ui"]["theme"],
		getAllThemes: vi.fn(async () => []),
		getTheme: vi.fn(async () => undefined),
		setTheme: vi.fn(async () => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} satisfies ExtensionContext["ui"];
}

function createMinimalExtensionContextInternal(overrides: ExtensionContextOverrides = {}): ExtensionContext {
	const cwd = overrides.cwd ?? process.cwd();
	const model = overrides.model ?? makeModel("composer-2.5");
	const base: ExtensionContext = {
		ui: createMinimalExtensionUi(),
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: createMinimalSessionManager(cwd, overrides.sessionManager),
		modelRegistry: getSharedTestModelRegistry(),
		model,
		models: {
			list: vi.fn(() => (model ? [model] : [])),
			current: vi.fn(() => model),
			resolve: vi.fn(() => undefined),
			family: vi.fn((candidate) => `${candidate.provider}/${candidate.id}`),
		},
		isIdle: vi.fn(() => true),
		isProjectTrusted: vi.fn(() => true),
		abort: vi.fn(),
		hasPendingMessages: vi.fn(() => false),
		shutdown: vi.fn(),
		getContextUsage: vi.fn(() => undefined),
		getAsyncJobSnapshot: vi.fn(() => null),
		compact: vi.fn(),
		getSystemPrompt: vi.fn(() => []),
		setInterval: vi.fn() as ExtensionContext["setInterval"],
		setTimeout: vi.fn() as ExtensionContext["setTimeout"],
		clearTimer: vi.fn(),
	};
	return {
		...base,
		...overrides,
		ui: {
			...base.ui,
			...overrides.ui,
		},
		sessionManager: {
			...base.sessionManager,
			...overrides.sessionManager,
		},
	};
}

function createMinimalExtensionCommandContextInternal(
	overrides: ExtensionCommandContextOverrides = {},
): ExtensionCommandContext {
	const base = createMinimalExtensionContextInternal(overrides) as ExtensionCommandContext;
	return {
		...base,
		...overrides,
		waitForIdle: overrides.waitForIdle ?? vi.fn(async () => undefined),
		newSession: overrides.newSession ?? vi.fn(async () => ({ cancelled: false })),
		branch: overrides.branch ?? vi.fn(async () => ({ cancelled: false })),
		navigateTree: overrides.navigateTree ?? vi.fn(async () => ({ cancelled: false })),
		switchSession: overrides.switchSession ?? vi.fn(async () => ({ cancelled: false })),
		reload: overrides.reload ?? vi.fn(async () => undefined),
		ui: {
			...base.ui,
			...overrides.ui,
		},
		sessionManager: {
			...base.sessionManager,
			...overrides.sessionManager,
		},
	};
}

export function createExtensionTestContext(ctxOverrides: ExtensionContextOverrides = {}): ExtensionContext {
	return createMinimalExtensionContextInternal(ctxOverrides);
}

export function createExtensionCommandContext(
	ctxOverrides: ExtensionCommandContextOverrides = {},
): ExtensionCommandContext {
	return createMinimalExtensionCommandContextInternal(ctxOverrides);
}

export function makeContext(messages: Context["messages"] = [{ role: "user", content: "Hello", timestamp: 1 }]): Context {
	return {
		systemPrompt: ["Be helpful."],
		messages,
	};
}

export function makeAssistantMessage(text = "Done", timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "cursor-sdk",
		api: "cursor-sdk",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export async function collectEvents<TEvent>(stream: AsyncIterable<TEvent>): Promise<TEvent[]> {
	const events: TEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export async function collectAssistantEvents(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	return collectEvents(stream);
}

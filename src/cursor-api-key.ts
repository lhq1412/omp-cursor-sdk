import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { resolveApiKeyOnce, type ApiKey } from "@oh-my-pi/pi-ai";

export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

const CURSOR_API_KEY_PLACEHOLDERS: Record<string, true> = {
	[CURSOR_API_KEY_ENV_VAR]: true,
	[`$${CURSOR_API_KEY_ENV_VAR}`]: true,
	[`\${${CURSOR_API_KEY_ENV_VAR}}`]: true,
};
const LEGACY_CURSOR_API_KEY_PLACEHOLDER = "pi-cursor-sdk-cursor-api-key-placeholder";
export function isRemovedCursorApiKeyPlaceholder(apiKey: ApiKey | undefined): boolean {
	return typeof apiKey === "string" && apiKey.trim() === LEGACY_CURSOR_API_KEY_PLACEHOLDER;
}

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (isRemovedCursorApiKeyPlaceholder(trimmed)) return undefined;
	if (CURSOR_API_KEY_PLACEHOLDERS[trimmed]) return process.env.CURSOR_API_KEY?.trim() || undefined;
	return trimmed;
}

export function getCursorSdkProviderApiKeyConfig(): string | undefined {
	return process.env[CURSOR_API_KEY_ENV_VAR]?.trim() ? CURSOR_API_KEY_ENV_VAR : undefined;
}

export function createCursorSdkApiKeyLogin(): NonNullable<ProviderConfig["oauth"]> {
	return {
		name: "Cursor SDK API key",
		login: async (callbacks) => {
			const apiKey = (await callbacks.onPrompt({
				message: "Paste a Cursor SDK API key from Cursor Dashboard → API Keys",
				placeholder: "crsr_...",
			})).trim();
			if (!apiKey) throw new Error("A Cursor SDK API key is required.");
			return apiKey;
		},
	};
}

/**
 * Resolve an ApiKey that may be a resolver to the literal string the Cursor
 * SDK needs. OMP can hand providers a static string or an ApiKeyResolver
 * (minting/rotation); discarding the resolver would surface a false
 * "missing API key". Uses OMP's own initial-resolve helper.
 */
export async function resolveCursorStringApiKey(apiKey: ApiKey | undefined): Promise<string | undefined> {
	return resolveCursorApiKey(await resolveApiKeyOnce(apiKey));
}

/**
 * Sync narrowing for key-adjacent paths that only use the key for scrubbing
 * or as a fallback (the primary resolution is requireCursorApiKey). A
 * resolver form is not a literal to scrub or fall back on.
 */
export function resolveCursorStringApiKeySync(apiKey: ApiKey | undefined): string | undefined {
	return typeof apiKey === "string" ? resolveCursorApiKey(apiKey) : undefined;
}

/**
 * Resolve the environment fallback used by startup discovery and turns.
 * OMP resolves CLI, provider-config, and login-saved `cursor-sdk` credentials;
 * this fallback covers `CURSOR_API_KEY`, including OMP's auto-loaded
 * `~/.omp/.env`, without opening a second credential-store connection.
 */
export async function resolveCursorRuntimeApiKey(): Promise<string | undefined> {
	return resolveCursorApiKey(process.env.CURSOR_API_KEY);
}

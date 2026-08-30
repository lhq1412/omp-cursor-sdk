import type { ModelListItem } from "@cursor/sdk";

export interface CursorContextTier {
	value: string;
	contextWindowKey: string;
}

export interface CursorTwoTierContextPolicy {
	standard: CursorContextTier;
	extended: CursorContextTier;
}

export interface CursorModelSelectionIdentity {
	model: ModelListItem;
	context?: string;
	contextTiers?: CursorTwoTierContextPolicy;
	piModelId: string;
	contextWindowKey: string;
}

export declare function parseCursorContextWindowValue(value: string): number | undefined;

export declare function getCursorModelSelectionIdentities(
	models: readonly ModelListItem[],
): CursorModelSelectionIdentity[];

export declare function normalizeCursorContextWindowEntries(
	models: readonly ModelListItem[],
	entries: ReadonlyMap<string, number>,
	source?: string,
): Map<string, number>;

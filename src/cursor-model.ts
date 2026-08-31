import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const CURSOR_SDK_PROVIDER_ID = "cursor-sdk";
export const CURSOR_SDK_API = "cursor-sdk";

export type CursorModelRef =
	| Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api">
	| undefined;

export function isCursorModel(model: CursorModelRef): boolean {
	return model?.provider === CURSOR_SDK_PROVIDER_ID;
}

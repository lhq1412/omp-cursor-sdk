export type CursorSdkModule = typeof import("@cursor/sdk");

export async function loadCursorSdk(): Promise<CursorSdkModule> {
	return import("@cursor/sdk");
}

let runtimeWarmup: Promise<void> | undefined;

export function prewarmCursorSdkRuntime(loader: () => Promise<unknown> = loadCursorSdk): Promise<void> {
	runtimeWarmup ??= loader()
		.then(() => undefined)
		.catch((error: unknown) => {
			runtimeWarmup = undefined;
			throw error;
		});
	return runtimeWarmup;
}

export function resetCursorSdkRuntimePrewarmForTests(): void {
	runtimeWarmup = undefined;
}

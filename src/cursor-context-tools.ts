import type { Context } from "@oh-my-pi/pi-ai";

/** Tool names from the provider context snapshot at stream start (not live OMP getActiveTools()). */
export function getActiveContextToolNames(context: Context): ReadonlySet<string> | undefined {
	return context.tools ? new Set(context.tools.map((tool) => tool.name)) : undefined;
}

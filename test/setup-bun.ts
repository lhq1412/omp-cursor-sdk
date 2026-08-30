import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-bun-test-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
process.once("exit", () => {
	rmSync(isolatedAgentDir, { recursive: true, force: true });
});

// Bun maps Vitest imports to its compatibility layer during `bun test`, but the
// layer omits a few small helpers used by the inherited suite. Keep those
// shims test-only so production code continues to run against native OMP/Bun.
const compat = vi as unknown as Record<string, unknown>;

if (typeof compat.hoisted !== "function") {
	compat.hoisted = <T>(factory: () => T): T => factory();
}

if (typeof compat.mocked !== "function") {
	compat.mocked = <T>(value: T): T => value;
}

if (typeof compat.waitFor !== "function") {
	compat.waitFor = async <T>(
		assertion: () => T | Promise<T>,
		options?: number | { timeout?: number; interval?: number },
	): Promise<T> => {
		const timeout = typeof options === "number" ? options : (options?.timeout ?? 1_000);
		const interval = typeof options === "number" ? 10 : (options?.interval ?? 10);
		const attempts = Math.max(1, Math.ceil(timeout / Math.max(interval, 1)));
		const fakeTimers =
			typeof compat.isFakeTimers === "function" &&
			Reflect.apply(compat.isFakeTimers, vi, []) === true;
		let lastError: unknown;

		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				return await assertion();
			} catch (error) {
				lastError = error;
			}
			await new Promise<void>((resolve) => {
				if (fakeTimers) {
					setImmediate(resolve);
				} else {
					setTimeout(resolve, interval);
				}
			});
		}

		throw lastError;
	};
}

if (typeof compat.advanceTimersByTimeAsync !== "function") {
	compat.advanceTimersByTimeAsync = async (milliseconds: number): Promise<void> => {
		await Promise.resolve();
		vi.advanceTimersByTime(milliseconds);
		await Promise.resolve();
	};
}

if (typeof compat.runAllTimersAsync !== "function") {
	compat.runAllTimersAsync = async (): Promise<void> => {
		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();
	};
}

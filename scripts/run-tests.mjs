#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = resolve(root, "test");
const forwardedArgs = [];
const requestedFiles = [];

for (const arg of process.argv.slice(2)) {
	if (arg.endsWith(".test.ts") && !arg.startsWith("--")) {
		requestedFiles.push(resolve(root, arg));
		continue;
	}
	forwardedArgs.push(arg.replace(/^--testTimeout(?==|$)/, "--timeout"));
}

function collectTestFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTestFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".test.ts") && !entry.name.endsWith(".compile.test.ts")) {
			files.push(path);
		}
	}
	return files;
}

const files = (requestedFiles.length > 0 ? requestedFiles : collectTestFiles(testDir)).sort();

if (files.length === 0) {
	console.error("[test] no test files matched");
	process.exit(2);
}

const requestedConcurrency = Number.parseInt(process.env.OMP_TEST_CONCURRENCY ?? "4", 10);
const concurrency = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
	? Math.min(requestedConcurrency, files.length)
	: Math.min(4, files.length);
const requestedTimeout = Number.parseInt(process.env.OMP_TEST_FILE_TIMEOUT_MS ?? "120000", 10);
const fileTimeoutMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 120_000;
let nextIndex = 0;
const failures = [];

async function runTestFile(file) {
	const child = spawn(process.execPath, ["test", "--isolate", ...forwardedArgs, file], {
		cwd: root,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const settled = Promise.withResolvers();
	child.once("error", (error) => settled.resolve({ code: null, error }));
	child.once("close", (code, signal) => settled.resolve({ code, signal }));
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, fileTimeoutMs);
	timer.unref?.();
	const result = await settled.promise;
	clearTimeout(timer);
	if (result.code === 0 && !timedOut) return;
	failures.push({
		file: relative(root, file),
		stdout,
		stderr,
		reason: timedOut
			? `timed out after ${fileTimeoutMs}ms`
			: result.error?.message ?? `exited ${result.code ?? result.signal ?? "unknown"}`,
	});
}

async function worker() {
	while (nextIndex < files.length) {
		const index = nextIndex;
		nextIndex += 1;
		await runTestFile(files[index]);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

for (const failure of failures) {
	console.error(`\n[test] FAIL ${failure.file}: ${failure.reason}`);
	if (failure.stdout.trim()) process.stderr.write(failure.stdout);
	if (failure.stderr.trim()) process.stderr.write(failure.stderr);
}

const passed = files.length - failures.length;
console.log(`[test] ${passed}/${files.length} files passed (${concurrency} workers)`);
if (failures.length > 0) process.exitCode = 1;

#!/usr/bin/env node
/**
 * Opt-in live contract: does official @cursor/sdk + Fable reject MCP tool schemas
 * that still carry anyOf/oneOf (and accept the OMP sanitizeSchemaForCursor projection)?
 *
 * Default CI does not run this. Enable when Fable + CURSOR_API_KEY are available:
 *
 *   PI_CURSOR_SDK_FABLE_SCHEMA_CONTRACT=1 CURSOR_API_KEY=... \
 *     node scripts/probe-fable-mcp-schema-contract.mjs
 *
 * Evidence shape (stdout JSON):
 *   { withoutSanitize: "reject"|"accept"|"error", withSanitize: "reject"|"accept"|"error", model, detail? }
 *
 * Production bridge auto-enable stays off until this (or equivalent) captures reject→accept.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeSchemaForMCP, sanitizeSchemaForCursor, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { defaultApiKeyFromEnv, parseArgv } from "./lib/cursor-cli-args.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";
import { suppressCursorSdkOutput } from "./lib/cursor-sdk-output-filter.mjs";

const fail = createScriptFail("probe-fable-mcp-schema-contract");
const COMBINER_TOOL = {
	name: "union_echo",
	description: "Echo mode from a combiner schema",
	parameters: {
		type: "object",
		properties: {
			mode: {
				anyOf: [
					{ type: "string", enum: ["a"] },
					{ type: "string", enum: ["b"] },
				],
			},
		},
		required: ["mode"],
	},
};

function projectSchema(sanitize) {
	const wire = toolWireSchema(COMBINER_TOOL);
	const projected = sanitize ? sanitizeSchemaForCursor(wire) : wire;
	return normalizeSchemaForMCP(projected);
}

async function startMcpServer(inputSchema) {
	const mcp = new Server({ name: "fable-schema-probe", version: "1.0.0" }, { capabilities: { tools: {} } });
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "union_echo",
				description: COMBINER_TOOL.description,
				inputSchema,
			},
		],
	}));
	mcp.setRequestHandler(CallToolRequestSchema, async (req) => ({
		content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? {}) }],
	}));

	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	await mcp.connect(transport);

	const httpServer = createServer(async (req, res) => {
		await transport.handleRequest(req, res);
	});
	await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("failed to bind MCP probe server");
	const url = `http://127.0.0.1:${address.port}/mcp`;
	return {
		url,
		async close() {
			await transport.close().catch(() => undefined);
			await new Promise((resolve) => httpServer.close(() => resolve()));
		},
	};
}

function classifyOutcome(errorText) {
	const text = errorText.toLowerCase();
	if (
		text.includes("anyof") ||
		text.includes("oneof") ||
		text.includes("allof") ||
		text.includes("invalid schema") ||
		text.includes("tool schema") ||
		text.includes("json schema") ||
		/\b400\b/.test(text)
	) {
		return "reject";
	}
	return "error";
}

async function runOnce({ apiKey, modelId, sanitize, cwd }) {
	const schema = projectSchema(sanitize);
	const server = await startMcpServer(schema);
	let agent;
	try {
		const { Agent } = await import("@cursor/sdk");
		agent = await suppressCursorSdkOutput(() =>
			Agent.create({
				apiKey,
				model: { id: modelId },
				local: { cwd, settingSources: [] },
				mcpServers: {
					probe: { type: "http", url: server.url },
				},
			}),
		);
		const run = await agent.send("Reply with exactly OK. Do not call tools.");
		await run.wait();
		return { status: "accept", schemaHasCombiner: JSON.stringify(schema).includes('"anyOf"') };
	} catch (error) {
		const message = scrubSensitiveText(error instanceof Error ? error.message : String(error), [apiKey]);
		return { status: classifyOutcome(message), detail: message, schemaHasCombiner: JSON.stringify(schema).includes('"anyOf"') };
	} finally {
		await agent?.[Symbol.asyncDispose]?.().catch(() => undefined);
		await agent?.dispose?.().catch(() => undefined);
		await server.close();
	}
}

function printHelp() {
	console.log(`Opt-in Fable MCP schema contract probe (official @cursor/sdk).

Requires:
  PI_CURSOR_SDK_FABLE_SCHEMA_CONTRACT=1
  CURSOR_API_KEY
  a Fable model id (default claude-5-fable-high)

Usage:
  PI_CURSOR_SDK_FABLE_SCHEMA_CONTRACT=1 CURSOR_API_KEY=... node scripts/probe-fable-mcp-schema-contract.mjs
  node scripts/probe-fable-mcp-schema-contract.mjs --model claude-5-fable-high
`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
	if (argv.includes("-h") || argv.includes("--help")) {
		printHelp();
		return;
	}
	if (env.PI_CURSOR_SDK_FABLE_SCHEMA_CONTRACT !== "1") {
		fail("set PI_CURSOR_SDK_FABLE_SCHEMA_CONTRACT=1 to run this live contract probe");
	}
	const args = parseArgv(argv, {
		defaults: {
			apiKey: defaultApiKeyFromEnv(env),
			model: "claude-5-fable-high",
		},
		flags: {
			apiKey: { names: ["--api-key"], assign: (value) => value.trim() },
			model: { names: ["--model"], assign: (value) => value.trim() },
		},
		fail: (message) => fail(message, defaultApiKeyFromEnv(env)),
	});
	if (!args.apiKey) fail("CURSOR_API_KEY or --api-key required", args.apiKey);

	const cwd = await mkdtemp(join(tmpdir(), "fable-mcp-schema-"));
	try {
		const withoutSanitize = await runOnce({ apiKey: args.apiKey, modelId: args.model, sanitize: false, cwd });
		const withSanitize = await runOnce({ apiKey: args.apiKey, modelId: args.model, sanitize: true, cwd });
		const result = {
			model: args.model,
			withoutSanitize: withoutSanitize.status,
			withSanitize: withSanitize.status,
			withoutSanitizeDetail: withoutSanitize.detail,
			withSanitizeDetail: withSanitize.detail,
			withoutSanitizeHasCombiner: withoutSanitize.schemaHasCombiner,
			withSanitizeHasCombiner: withSanitize.schemaHasCombiner,
		};
		console.log(JSON.stringify(result, null, 2));
		const ok = withoutSanitize.status === "reject" && withSanitize.status === "accept";
		if (!ok) {
			process.exitCode = 2;
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("probe-fable-mcp-schema-contract.mjs")) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}

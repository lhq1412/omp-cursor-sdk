# Cursor testing lessons

Current maintainer lessons for `omp-cursor-sdk` on OMP 18. Historical Pi CLI assumptions are not valid for this branch.

Release commands and targets: [Platform smoke gate](./platform-smoke.md). Minimal manual pass: [Cursor dogfood checklist](./cursor-dogfood-checklist.md).

## Run extension tests under Bun

OMP 18 requires Bun and exposes Bun globals during module loading. Importing the extension graph with Node/Vitest fails before tests reach provider behavior.

Use:

```bash
npm test
npm run typecheck
```

`npm test` recursively runs each runtime `test/**/*.test.ts` file in a separate Bun process; compile-only contracts are excluded. This boundary is intentional: module mocks for `@cursor/sdk`, OMP registration, timers, and process guards otherwise leak between files and create order-dependent failures.

When narrowing one file:

```bash
bun test --isolate test/cursor-provider-replay-live-run.test.ts
```

Compile-only contracts remain under `npm run typecheck:replay-compile`.

Node-only maintainer-script probes must launch `node` explicitly. Inside Bun tests, `process.execPath` points to Bun and must not be used with Node-only flags such as `--check` or `--experimental-loader`.

## OMP loads TypeScript directly

The package manifest points to `src/index.ts`. There is no generated `dist/` build:

```bash
npm install
omp plugin link .
```

A direct local launch may use `-e .`. Do not add an obsolete build step or validate stale generated output.

## Authentication is provider-specific

`cursor-sdk` does not inherit OMP's builtin `cursor` provider credential.

Resolution order:

1. OMP's invocation/API-key resolution for `cursor-sdk`;
2. the saved `/login cursor-sdk` credential;
3. `CURSOR_API_KEY`.

Tests must prove that missing auth stays missing and explicitly clear/restore ambient `CURSOR_API_KEY` around that assertion. Never inject a placeholder API key merely to register dynamic models.

Live isolated smoke currently requires `CURSOR_API_KEY`; it does not copy legacy `~/.pi/agent/auth.json`.

## Dynamic model tests need two contracts

Model discovery owns two representations:

- raw Cursor SDK metadata, cached by API-key fingerprint;
- normalized OMP model definitions, rebuilt for each registry request.

Test cache safety independently from normalization. A cached normalized model object can retain stale provider IDs, transport fields, or role/context variants.

SDK-dependent tests must be backed by the installed package, official TypeScript SDK documentation, or captured fixtures. Do not invent model parameters, timing, usage, or event payloads in mocks.

## Provider identity must stay strict

All extension models use:

```text
provider = cursor-sdk
api      = cursor-sdk
```

Tests must also register OMP's builtin `cursor` provider/model and prove that:

- this extension does not replace it;
- replay lifecycle does not activate for it;
- credentials do not cross providers;
- fallback occurs only when OMP `retry.fallbackChains` explicitly requests it.

## Replay is neutral in OMP

OMP does not expose builtin executable definitions for extension wrapping. Native replay therefore uses one registered `cursor` tool.

Provider tests should assert:

- SDK activity emits `toolCall.name === "cursor"`;
- result details retain `sourceToolName`;
- `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` were not extension-registered;
- an unknown replay ID cannot execute real work;
- bridge activity still records the real OMP tool name.

Do not update a bridge assertion from `read` to `cursor`: bridge calls and SDK replay are different contracts.

## Synchronize asynchronous tests on behavior

One `await Promise.resolve()` is not a reliable readiness barrier under Bun.

Wait for a concrete signal:

- SDK `run.wait()` was called;
- a mock send started;
- a listener registered;
- a `Promise.withResolvers()` gate opened;
- a live-run count reached the expected state.

This prevents deltas from being delivered before the continuation stream owns the live run.

## OMP session semantics

OMP 18 removed the old `--session-id` launch flag. Use:

- `--session-dir` for isolation;
- `--continue` for the latest persisted session.

Session tests must verify JSONL and provider metadata, not assistant recall alone.

OMP may run a background advisor after `session_shutdown`. A terminally closed interactive Cursor-agent scope stays closed, while the late turn receives an isolated `<scope>::background` pool. Test that the in-flight old agent is disposed and the background acquire cannot reuse it.

## Project trust and configuration

Non-secret configuration lives in:

- `~/.omp/agent/cursor-sdk.json`;
- trusted project `.omp/cursor-sdk.json`.

The extension consumes OMP's `ctx.isProjectTrusted()` result. Contract tests should isolate `PI_CODING_AGENT_DIR`, HOME, project directories, and Git config so host state cannot make a false pass.

## JSONL is the execution oracle

Assistant text can narrate a tool call without executing it.

For replay or bridge bugs, inspect:

- assistant `toolCall` IDs and names;
- matching `toolResult.toolCallId`;
- `toolResult.toolName`;
- `details.sourceToolName`;
- provider/api/model;
- usage;
- provider/debug metadata;
- session lineage and resume entries.

A rendered card plus matching JSONL is required for visual claims.

## Debug capture

Provider event capture:

```bash
npm run debug:provider-events -- \
  --model cursor-sdk/grok-4.6 \
  --prompt 'Repro prompt here' \
  --out .debug/cursor-sdk-events/manual-repro
```

SDK-only capture:

```bash
npm run debug:sdk-events -- \
  --model cursor-sdk/grok-4.6 \
  --prompt 'Repro prompt here' \
  --out /tmp/omp-cursor-sdk-sdk-events-manual
```

Raw artifacts may contain prompts, paths, tool arguments/results, and secrets. Keep them gitignored and local.

## Release evidence

Unit tests are necessary but insufficient for provider/runtime changes:

```bash
npm test
npm run typecheck
npm pack --dry-run
npm run smoke:platform:all
```

Cloud runtime changes also require `npm run smoke:cloud`. Missing auth or platform infrastructure is a release blocker, not a skipped pass.

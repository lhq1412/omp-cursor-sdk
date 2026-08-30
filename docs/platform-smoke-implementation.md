# Platform smoke implementation reference

This document describes the current `omp-cursor-sdk` platform-smoke harness. User-facing commands and release policy live in [Platform smoke gate](./platform-smoke.md).

## Entry points

- `scripts/platform-smoke.mjs` — CLI and required-target orchestration.
- `scripts/platform-smoke/targets.mjs` — reusable target leases, suite execution, package preparation, and evidence collection.
- `scripts/platform-smoke/scenarios.mjs` — live scenario prompts and assertion contracts.
- `scripts/platform-smoke/local-resume-suites.mjs` — resume lane definitions.
- `scripts/platform-smoke/doctor.mjs` — fail-fast host/provider/target checks.
- `platform-smoke.config.mjs` — package, model, target, image, and artifact defaults.

Maintainer orchestration is Node ESM. OMP 18's CLI is launched with Bun on every target.

## Target adapters

`scripts/platform-smoke/crabbox-runner.mjs` owns all Crabbox process calls:

- safe environment construction;
- Ubuntu image preparation;
- macOS/Ubuntu/Windows target arguments;
- reusable lease warmup;
- sync/no-sync execution;
- target cleanup.

Target identity:

| Smoke target | Crabbox provider | Runtime surface |
|---|---|---|
| `macos` | `ssh` | native PTY |
| `ubuntu` | `local-container` | Linux PTY |
| `windows-native` | `parallels` | Windows ConPTY |

One lease is reused sequentially for the target's required suites. Required targets themselves also run sequentially to avoid shared-host and API contention.

The generated Ubuntu image copies the pinned Bun binary from `oven/bun:1.3.14` into the configured Node 24 base and executes `bun --version` during the build. macOS and Windows doctor probes require Bun on the native target.

## Package preparation

The `platform-build` path in `scripts/platform-smoke/targets.mjs`:

1. runs target-local `npm ci`;
2. runs package checks and tests;
3. creates the npm tarball;
4. installs the tarball into a clean target-local project;
5. verifies package identity and manifest;
6. returns paths consumed by live suites.

The packed manifest exposes `src/index.ts` directly through OMP's extension field. No `dist/` directory or compile-before-launch step exists.

Project activation uses OMP's package manager:

```bash
omp plugin install --scope project <tarball>
omp plugin list --scope project
```

## OMP launch

`scripts/platform-smoke/live-suite-runner.mjs` owns the target-side live invocation.

It resolves the installed `@oh-my-pi/pi-coding-agent/dist/cli.js` entry and launches:

```text
bun <omp-cli-entry> --auto-approve --model cursor-sdk/grok-4.6 ...
```

The prompt is a positional interactive message. Session continuation uses `--session-dir` and `--continue`; OMP 18 has no `--session-id` launch flag.

Every suite gets:

- an isolated workspace;
- an isolated `PI_CODING_AGENT_DIR`;
- explicit environment allowlisting;
- bounded timeout and output;
- a suite-specific terminal-final marker;
- provider/debug metadata paths.

## Native replay evidence

Cursor SDK-native activity must not register or replace OMP builtins.

The extension registers one neutral replay tool:

```text
cursor
```

For source activity such as `read`, `grep`, `find`, `bash`, `edit`, or `write`:

- history `toolCall.name` is `cursor`;
- display/result details retain `sourceToolName`;
- an unknown replay ID remains display-only and cannot execute real work.

`cursor-native-visual-matrix` correlates those details with ANSI cards and the underlying session JSONL.

## Bridge evidence

Bridge calls remain ordinary OMP tool calls:

```text
Cursor agent -> loopback MCP pi__* -> OMP tool -> MCP result
```

The bridge matrix uses exactly:

- `pi__bash`;
- successful `pi__read`;
- failing `pi__read`.

Its JSONL therefore records `bash`/`read`, not the neutral replay name. Diagnostics correlate endpoint and tool-call identity while redacting endpoint tokens and authorization data.

## Session and resume lanes

`scripts/platform-smoke/local-resume-suites.mjs` defines bounded scenarios for:

- restart reuse;
- unsafe copied-session rejection;
- tool-surface invalidation;
- abort cleanup;
- tree navigation;
- copy/switch lineage;
- missing-agent fallback;
- compaction generation;
- default dry-run precedence;
- recorded-ID-only cleanup.

The concrete target runner records both OMP session JSONL and Cursor lifecycle/lineage state. Assistant text is never accepted as resume proof.

## PTY/ConPTY capture

Target launch uses real terminal semantics. The capture path records:

- raw ANSI;
- normalized plain text;
- process exit and timeout state;
- final marker;
- session JSONL location;
- provider/debug artifacts.

`wrapped-line-match.mjs` matches bounded terminal wrapping without flattening unrelated text.

## Rendering

`scripts/lib/cursor-visual-render.mjs` and platform rendering helpers own the single canonical browser path:

```text
ANSI -> xterm DOM -> HTML + PNG
```

Visual assertions require two independent signals:

1. a rendered card/output pattern;
2. a matching JSONL tool result.

This prevents prompt echo or assistant narration from satisfying an execution assertion.

## Artifact bundle

`artifact-bundle-contract.mjs` owns bundle path, size, and shape limits.

`artifact-fs-safety.mjs` owns:

- canonical relative-path validation;
- no-follow traversal;
- bounded reads;
- extraction preflight;
- safe spill writes.

`artifact-anchored-extract.mjs` delegates POSIX mutation to `artifact-openat-extract.c`, using directory-descriptor-relative operations and rollback. Windows controller extraction fails closed where equivalent handle-relative mutation is unavailable.

Every file is size-checked and checksummed. Canonical base64 and aggregate inflated-byte limits prevent alternate encodings and decompression amplification.

## Secret handling

`artifact-secrets.mjs` uses the shared Cursor secret scrubber for both producer and controller checks.

The harness does not include:

- `CURSOR_API_KEY`;
- saved OMP credentials;
- authorization/cookie headers;
- tokenized bridge URLs;
- unbounded raw SDK event captures.

Secrets enter target processes only through explicit environment allowlists. Crabbox commands and captured command metadata omit their values.

## Failure semantics

A suite writes evidence on success and failure. The runner then:

1. records assertions and command status;
2. redacts and scans the bundle;
3. attempts target/process cleanup;
4. extracts bounded artifacts;
5. updates run summary/latest metadata;
6. returns nonzero for any missing prerequisite, assertion, cleanup, or extraction proof.

An artifact transport error does not downgrade to missing evidence. It fails the suite.

## Extension points

Add a platform suite only when it proves a distinct runtime contract.

Required additions:

1. register the suite centrally;
2. declare target and live/auth requirements;
3. reuse package preparation and launch helpers;
4. define bounded terminal and JSONL assertions;
5. include cleanup proof;
6. update the user-facing platform runbook;
7. add focused tests for pure parsing, routing, and artifact boundaries.

Do not duplicate process launch, secret redaction, ANSI rendering, or filesystem extraction code inside a suite.

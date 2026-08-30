# Cursor live smoke checklist

The release gate for local provider/runtime changes is:

```bash
npm run smoke:platform:all
```

Cloud execution changes additionally require:

```bash
npm run smoke:cloud
```

The checks below are inner-loop diagnostics. They do not replace the macOS, Ubuntu, and Windows-native platform matrix.

## Prerequisites

- Bun 1.3.14 or newer.
- Node 22.19.0 or newer for maintainer scripts.
- OMP 18.0.11.
- A Cursor SDK API key available through `/login cursor-sdk`, `--api-key`, or `CURSOR_API_KEY`.
- `npm install` completed.

The OMP manifest loads `src/index.ts` directly. Do not run an obsolete `npm run build` step.

## Registration and discovery

```bash
omp --version
npm ls @cursor/sdk @oh-my-pi/pi-coding-agent @oh-my-pi/pi-ai @oh-my-pi/pi-tui
omp models cursor-sdk -e .
```

Required:

- provider name is `cursor-sdk`;
- model IDs start with `cursor-sdk/`;
- OMP's builtin `cursor` provider remains separate;
- only canonical SDK IDs are listed; aliases such as `gpt-5-5` and `composer-2-5` are absent;
- no API key is printed.

## One-shot local provider check

```bash
SMOKE_DIR="$(mktemp -d /tmp/omp-cursor-sdk-live.XXXXXX)"

PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_PI_TOOL_BRIDGE=0 \
omp --auto-approve -e . \
  --model cursor-sdk/grok-4.6 --cursor-no-fast \
  --session-dir "$SMOKE_DIR/basic" \
  -p 'Reply exactly OMP_CURSOR_SDK_OK.'
```

Required:

- exit status 0;
- final output contains `OMP_CURSOR_SDK_OK`;
- the persisted assistant message has `provider: "cursor-sdk"` and `api: "cursor-sdk"`;
- usage fields are non-negative and internally consistent.

## Interactive replay check

```bash
npm run smoke:visual -- \
  --ext "$PWD" \
  --cwd "$PWD" \
  --model cursor-sdk/grok-4.6 \
  --label read-package \
  --prompt 'Read ./package.json with your file tool, then answer with only the package name.' \
  --out-dir "$SMOKE_DIR/visual"
```

Inspect the generated ANSI/HTML/PNG and session JSONL together.

Required:

- `omp-cursor-sdk` is visible;
- SDK activity enters OMP as `toolCall.name === "cursor"`;
- the result retains `details.sourceToolName === "read"` when source metadata is available;
- OMP builtin tools are not shadowed;
- no replay-only tool executes filesystem or shell work.

## OMP bridge check

```bash
PI_CURSOR_SETTING_SOURCES=none \
PI_CURSOR_PI_TOOL_BRIDGE=1 \
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 \
PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1 \
omp --auto-approve -e . \
  --model cursor-sdk/grok-4.6 \
  --session-dir "$SMOKE_DIR/bridge" \
  -p 'Call pi__read on ./package.json, then answer BRIDGE_NAME=<package name>.'
```

Required:

- the SDK calls `pi__read`;
- OMP history records the real `read` tool call/result, not a neutral replay call;
- the result contains `omp-cursor-sdk`;
- diagnostics contain no credentials or tokenized endpoint URLs.

## Thinking, context, and speed

Exercise thinking and speed with one-shot runs:

```bash
omp --auto-approve -e . --model cursor-sdk/gpt-5.5:xhigh -p 'Reply THINKING_OK.'
omp --auto-approve -e . --model cursor-sdk/grok-4.6 --cursor-fast -p 'Reply FAST_OK.'
omp --auto-approve -e . --model cursor-sdk/grok-4.6 --cursor-no-fast -p 'Reply SLOW_OK.'
```

Then start one interactive `cursor-sdk/gpt-5.5` session and exercise OMP's native control:

```text
/extended-context off
Reply CONTEXT_STANDARD_OK.
/extended-context on
Reply CONTEXT_EXTENDED_OK.
```

Validate provider/debug metadata rather than assistant prose:

- `:thinking` becomes SDK reasoning/thinking parameters;
- the catalog has one `gpt-5.5` row and no `gpt-5.5@272k` row;
- native extended context sends `context=272k` when off and `context=1m` when on;
- the catalog contains no `@fast` or `@slow` model identities;
- `--cursor-fast` and `--cursor-no-fast` produce matching SDK `fast` parameters while speed remains independent extension state.

## Session continuation

Use `--session-dir` and OMP's `--continue`; OMP 18 does not accept the removed `--session-id` flag.

```bash
SESSION_DIR="$SMOKE_DIR/session"
omp --auto-approve -e . --model cursor-sdk/grok-4.6 --session-dir "$SESSION_DIR" -p 'Remember marker ALPHA. Reply FIRST_OK.'
omp --auto-approve -e . --model cursor-sdk/grok-4.6 --session-dir "$SESSION_DIR" --continue -p 'Reply with the marker from the prior turn.'
```

Check the session JSONL and Cursor provider metadata for the expected scope, lineage, and resume decision.

## Failure and abort checks

- Missing auth must fail with a scrubbed `cursor-sdk` authentication error.
- Aborting a local run must cancel bridge work and release the live run.
- Incomplete started SDK tools must produce a bounded trace or replay card, never a fabricated success.
- Provider errors must not include API keys, bearer values, cookies, or tokenized bridge URLs.

## Debug artifacts

```bash
PI_CURSOR_SDK_EVENT_DEBUG=1 \
omp --auto-approve -e . --model cursor-sdk/grok-4.6 \
  --session-dir "$SMOKE_DIR/debug" \
  -p 'Reply DEBUG_OK.'
```

Artifacts under `.debug/cursor-sdk-events/` can include prompts, local paths, tool arguments, and results. Keep them local and gitignored.

## Release decision

Inner-loop evidence is useful only after the behavior above is observed. Release readiness still requires:

```bash
npm test
npm run typecheck
npm pack --dry-run
npm run smoke:platform:all
```

If auth, Crabbox, Docker, the macOS SSH target, or the Windows Parallels target is unavailable, report the release gate as blocked. Do not relabel a partial matrix as passing.

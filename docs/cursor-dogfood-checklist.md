# Cursor dogfood checklist

Fast one-session validation for `omp-cursor-sdk`. This is inner-loop evidence, not a substitute for [the platform smoke gate](./platform-smoke.md).

## Setup

```bash
npm install
export CURSOR_API_KEY="..."
export PI_CURSOR_SETTING_SOURCES=none
export PI_CURSOR_PI_TOOL_BRIDGE=1
export PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1

SESSION_DIR="$(mktemp -d /tmp/omp-cursor-dogfood.XXXXXX)"
omp --auto-approve -e . \
  --model cursor-sdk/grok-4.6 \
  --session-dir "$SESSION_DIR"
```

OMP loads `src/index.ts` directly under Bun. No build step is required.

## Checks

1. Run `/cursor-tools`.
   - Provider is `cursor-sdk`.
   - The callable manifest matches the active OMP tools.
   - No credential or loopback token is printed.

2. Ask Cursor to read `package.json` with its host file tool.
   - The card executes through the neutral OMP `cursor` replay tool.
   - Session JSONL retains `details.sourceToolName: "read"`.
   - The result contains `omp-cursor-sdk`.

3. Ask Cursor to call `pi__read` on `package.json`.
   - The bridge records the real OMP `read` tool call/result.
   - It is not confused with the display-only `cursor` replay call.

4. Ask Cursor to write and then edit a temporary file under `.debug/`.
   - Replay uses recorded results only.
   - The edit card shows a diff.
   - The persisted result carries `sourceToolName`.

5. Start a second turn in the same session.
   - The session-scoped agent is reused only when lineage and tool-surface checks allow it.
   - No prior replay result is duplicated.

6. Abort a long shell or bridge call.
   - OMP settles the turn.
   - The bridge endpoint and live run are released.
   - No orphan child remains.

## JSONL spot-check

Inspect the session file under `SESSION_DIR`.

Expected SDK replay shape:

```json
{
  "role": "toolResult",
  "toolName": "cursor",
  "details": {
    "sourceToolName": "read"
  }
}
```

Expected OMP bridge shape:

```json
{
  "role": "toolResult",
  "toolName": "read"
}
```

Tool-call IDs and result IDs must match exactly. Assistant prose that describes a tool call is not evidence of execution.

## Finish

```bash
npm test
npm run typecheck
npm pack --dry-run
```

Delete the temporary session/debug directory after inspection. Do not retain or commit raw prompts, tool payloads, local paths, or secrets.

# OMP upstream: `handlers.mcp` cancel context

Status: **proposal** (OMP host change required)  
Baseline: OMP 18.1.x `@oh-my-pi/pi-coding-agent` / extension `main` after A-stage opt-in  
Blocks: default-on `PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS`, bridge deletion (plan PR5)

## Problem

Extension tools on the SDK `customTools` path call `CursorExecHandlers.mcp` with an optional run-scoped `AbortSignal` (`src/cursor-omp-exec-adapter.ts`). OMP's bridge still drops cancel at the host registry boundary.

Installed OMP (`pi-coding-agent/src/cursor.ts`):

```ts
async function executeTool(...) {
  // ...
  result = await tool.execute(
    toolCallId,
    toolArgs,
    undefined,                      // onUpdate
    options.getToolContext?.(),     // ctx — no AbortSignal (5th param)
  );
}
```

Public host type (`@oh-my-pi/pi-ai` `CursorExecHandlers`):

```ts
mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
```

No call context; no way for extension MCP tools to stop subprocesses/tasks when the user interrupts a turn.

## Extension side (already landed)

| Piece | Location |
| --- | --- |
| `CursorExecCallContext { signal?: AbortSignal }` | `src/cursor-omp-exec-adapter.ts` |
| Pass `{ signal }` when run-scoped signal exists | `mcpHandler.call(handlers, call, signal ? { signal } : undefined)` |
| Run-scoped signal from provider send | `src/cursor-provider-turn-send.ts` → `createCursorOmpExtensionCustomTools(..., { signal: options?.signal })` |
| Adapter + mock handler stop contract | `test/cursor-omp-extension-mcp-custom-tools.test.ts` (`clearTimeout`, per-`toolCallId` records, post-deadline assert) |

Unit tests prove **adapter forwarding + cooperative handler cleanup**. They do **not** prove OMP host cancel safety.

## Proposed minimal OMP patch

No bridge reimplementation. No SDK `SDKCustomToolContext` change.

### 1. Types (`@oh-my-pi/pi-ai`)

```ts
export type CursorExecCallContext = {
  readonly signal?: AbortSignal;
};

// CursorExecHandlers
mcp?: (
  call: CursorMcpCall,
  context?: CursorExecCallContext,
) => Promise<CursorExecHandlerResult<McpResult>>;
```

Backward compatible: second argument optional.

### 2. Host bridge (`pi-coding-agent/src/cursor.ts`)

- `executeTool(..., signal?: AbortSignal)` — add optional trailing `signal`.
- `tool.execute(toolCallId, toolArgs, onUpdate, ctx, signal)` — pass as **5th** argument (matches `task/executor.ts` and custom-tool wrappers).
- `CursorExecHandlers.mcp(call, context?)` — forward `context?.signal` into `executeTool` for the resolved registry tool.

### 3. Interrupt wiring

When a Cursor provider turn is aborted, the run-scoped `AbortSignal` already reaches extension `customTools.execute` in this repo. After the host patch, the same signal must reach `tool.execute` for MCP registry tools invoked via `handlers.mcp`.

Document the wiring boundary in OMP (agent turn cancel → `CursorExecBridge` / exec dispatcher), not in this extension.

## Acceptance criteria (mirror unit fixture)

For an in-flight MCP tool call on the extension path:

| Check | Expected |
| --- | --- |
| Same-call cancel | Abort the pending invocation; do not start a second call |
| Handler receives signal | `context.signal` is the run-scoped signal |
| Owned work stops | Timers/subprocesses/tasks started by the tool are torn down on abort |
| Post-deadline | No side effects after the tool's natural completion window |
| Control call | Uncancelled sibling call completes normally |

Negative test: omitting handler-side cleanup (e.g. `clearTimeout`) must fail the stop assertion.

## Live verification (this repo)

| Script | Purpose |
| --- | --- |
| `npm run smoke:extension-mcp` | Structural opt-in path (no cancel proof) |
| `npm run smoke:extension-mcp-cancel` | Cancel **gate**: probe host gap (default); `--live` after upstream lands |

Probe implementation: `scripts/lib/cursor-host-cancel-probe.mjs` (`hostExecuteToolOmitsAbortSignal`).

`--live` body (to implement after host patch):

1. Opt-in extension tools + long-running OMP tool (e.g. `eval` sleep or `hub` wait).
2. Abort mid-flight (user interrupt / RPC cancel).
3. Assert: cancel error returned; no post-cancel writes; child process exited.

## Non-goals

- Default-on `PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS`
- Deleting `cursor-pi-tool-bridge-*`
- Changing `@cursor/sdk` custom tool context
- Reimplementing OMP exec dispatch in the extension

## References

- `docs/rewrite-omp-native-contract.md` — plan + gate table
- `scripts/extension-omp-mcp-smoke.mjs` — structural live smoke
- `scripts/extension-omp-mcp-cancel-smoke.mjs` — cancel gate smoke

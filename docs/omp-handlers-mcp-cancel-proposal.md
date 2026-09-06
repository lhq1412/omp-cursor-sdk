# OMP upstream: `handlers.mcp` cancel context

Status: **proposal** (OMP host change required)  
Baseline: OMP 18.1.x `@oh-my-pi/pi-coding-agent` / extension `main` after A-stage opt-in  
Blocks: default-on `PI_CURSOR_OMP_EXTENSION_CUSTOM_TOOLS`, bridge deletion (plan PR5)

## Problem

Extension tools on the SDK `customTools` path call `CursorExecHandlers.mcp` with an optional run-scoped `AbortSignal` (`src/cursor-omp-exec-adapter.ts`). OMP's bridge still drops cancel at the host registry boundary.

### AgentTool execute contract (what `cursor.ts` calls)

From `@oh-my-pi/pi-agent-core` `AgentToolExecFn`:

```ts
(
  toolCallId: string,
  params: Static<TParameters>,
  signal?: AbortSignal,                          // 3rd
  onUpdate?: AgentToolUpdateCallback<...>,       // 4th
  context?: AgentToolContext,                    // 5th
) => Promise<AgentToolResult<...>>
```

Installed OMP (`pi-coding-agent/src/cursor.ts`) currently does:

```ts
result = await tool.execute(
  toolCallId,
  toolArgs,
  undefined,                      // 3rd = signal slot — HOLE
  onUpdate,                       // 4th
  options.getToolContext?.(),     // 5th
);
```

`shellStream` uses the same hole: `tool.execute(toolCallId, toolArgs, undefined, onUpdate, ctx)`.

> **Do not confuse with CustomTool authoring order** `(toolCallId, params, onUpdate, ctx, signal)`.  
> `CustomToolAdapter` bridges authoring order → AgentTool order. Host `executeTool` talks to **AgentTool**, so **signal is 3rd**.

### Public host type

```ts
// @oh-my-pi/pi-ai CursorExecHandlers
mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
```

No call context; no way for extension MCP tools to stop subprocesses/tasks when the user interrupts a turn.

## Extension side (already landed)

| Piece | Location |
| --- | --- |
| `CursorExecCallContext { signal?: AbortSignal }` | `src/cursor-omp-exec-adapter.ts` |
| Pass `{ signal }` when run-scoped signal exists | `mcpHandler.call(handlers, call, signal ? { signal } : undefined)` |
| Run-scoped signal from provider send | `src/cursor-provider-turn-send.ts` → `createCursorOmpExtensionCustomTools(..., { signal: options?.signal })` |
| Adapter + mock handler stop contract | `test/cursor-omp-extension-mcp-custom-tools.test.ts` |

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

Keep existing `overrideTool` as the 5th helper parameter; append `signal` **after** it so current call sites stay valid:

```ts
async function executeTool(
  options: CursorExecBridgeOptions,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  overrideTool?: CursorBridgeTool,
  signal?: AbortSignal,            // NEW trailing helper arg
): Promise<ToolResultMessage> {
  // ...
  result = await tool.execute(
    toolCallId,
    toolArgs as Record<string, unknown>,
    signal,                        // AgentTool 3rd
    onUpdate,                      // 4th — unchanged
    options.getToolContext?.(),    // 5th — unchanged
  );
}
```

Same for the `shellStream` path that currently passes `undefined` in the signal slot.

`CursorExecHandlers.mcp(call, context?)` must forward `context?.signal` into `executeTool(..., signal)` for the resolved registry tool (and any `overrideTool` branch must not drop it).

### 3. Interrupt wiring

When a Cursor provider turn is aborted, the run-scoped `AbortSignal` already reaches extension `customTools.execute` in this repo. After the host patch, the same signal must reach `tool.execute` for MCP registry tools invoked via `handlers.mcp`.

Document the wiring boundary in OMP (agent turn cancel → `CursorExecBridge` / exec dispatcher), not in this extension.

### 4. Upstream acceptance (argument slots)

Host unit/contract tests must assert **all three** on a real registry tool invoke:

| Slot | Expected |
| --- | --- |
| 3rd `signal` | `===` call context signal |
| 4th `onUpdate` | same progress callback identity |
| 5th `context` | same host tool context |

Prevents “cancel wired, progress/context swapped”.

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

Probe: `scripts/lib/cursor-host-cancel-probe.mjs` classifies the **3rd** `tool.execute` argument inside `executeTool`:

| Evidence | Status |
| --- | --- |
| 3rd arg is `undefined` | `open` / blocked |
| 3rd arg looks like a signal expression | `source-wiring-observed` (not gate pass) |
| missing/unparsed source | `unknown` (never “ready”) |
| live stop assertions pass | only then cancel gate pass |

`--live` body (after host patch):

1. Opt-in extension tools + long-running OMP tool.
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
- `@oh-my-pi/pi-agent-core` `AgentToolExecFn` — authoritative AgentTool argument order

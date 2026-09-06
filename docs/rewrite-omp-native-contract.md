# Rewrite: OMP-native contract + thin Cursor SDK runtime

Branch: `rewrite/omp-native-contract`  
Baseline: `main` @ OMP 18.1.6 / `@cursor/sdk` 1.0.30  
**Status (single PR cutover):** extension tools default to `handlers.mcp` customTools; loopback bridge is skipped when `handlers.mcp` is present. Bridge modules remain for opt-in / tests. Cancel still host-limited (`executeTool` signal=`undefined`).

## Goal

Rebuild a thinner SDK-backed **local** runtime on OMP’s host contracts (Context, CursorExecHandlers, tool lifecycle, native UI). Keep existing model / session / cloud user contracts. Delete old code only after a replacement path is proven.

Not: delete first and re-grow. Not: copy OMP `cursor.ts` private protocol. Not: register builtin `cursor-agent` API or take over `cursor/*`.

## Frozen user contracts (round 1)

| Area | Decision |
| --- | --- |
| Provider/API | Keep independent `cursor-sdk/*`; do not override builtin `cursor` |
| Auth | Explicit SDK API key only |
| Model UX | Canonical identity, thinking, fast, standard/extended context unchanged |
| Session | Matching resume + branch/tree/copy/compaction isolation unchanged |
| Context | Keep #14 semantics / capability degradation |
| Cloud | Keep create/send/reporting/lifecycle shape |
| Public commands/config | Default unchanged; deprecations need migration notes |
| Deps | Pin current versions; upgrades separate PRs |

## Target shape

```
OMP host (registry / Context / grants / hooks / renderers)
  └─ cursor-sdk provider
       ├─ model projection + auth + config (keep)
       ├─ context reconciliation semantics (keep)
       ├─ Local runtime
       │    ├─ one SDK session owner
       │    ├─ one run terminal outcome
       │    ├─ one event/result adapter
       │    └─ SDK customTools
       │         ├─ builtin → CursorExecHandlers.pi*/legacy
       │         └─ extension → CursorExecHandlers.mcp
       └─ Cloud runtime (existing path)
            └─ @cursor/sdk
```

“One run lifecycle” means: do not split one SDK run across multiple OMP provider continuations **only** to hand off tool execution. Steering and multi-step SDK work remain allowed.

## PR sequence (plan numbers, not GitHub PRs)

### PR 0 — feasibility: extension tools via `handlers.mcp` (this spike)

Prove:

```
SDK customTools.execute
  → CursorExecHandlers.mcp(...)
  → live OMP tool instance
  → ToolResultMessage
  → optional cursorOnToolResult
  → SDK result (same run)
```

Decision rules:

- **All critical checks pass** → continue thin rewrite (PR 1+).
- **Missing host cancel/exec API only** → propose minimal OMP patch; do not reimplement host internals in the extension.
- **Cannot keep critical behavior** → keep loopback bridge; only delete other duplicate layers.

Hard gate: **cancel**. OMP 18.1.6 `executeTool` passes `undefined` as the AbortSignal into `tool.execute`. Unit coverage here cannot claim production cancel safety; live evidence must assert subprocess/task stop, no post-cancel writes, no cross-session backfill.

PR 0 output: tests + evidence + go/no-go. Not a new backend framework. Not production cutover.

### PR 1 — new local turn main path (builtins first)

Reuse: `cursor-omp-exec-adapter`, `context`, send-policy, model-discovery, api-key. Single agent/store owner; single terminal outcome; cloud branched at entry.

### PR 2 — extensions on the same OMP exec path

Active tool snapshot → SDK customTools; execute only if still in run grant set; `handlers.mcp` + `cursorOnToolResult`. One real executor per capability. SDK-native web/task/MCP stay on an explicit capability table. Only then drop loopback HTTP / pending result backfill for migrated tools.

### PR 3 — unify tool events / trim duplicate UI replay

| Data | Sole source |
| --- | --- |
| Real execution + progress | OMP execution handler |
| Persisted toolCall/toolResult | Provider unified record path |
| SDK-internal activity | Separate activity adapter (not a second execution) |

Keep `kCursorExecResolved` + cross-bundle identity tests. Delete OMP-owned replay first; keep minimal read-only display for old session replay records.

### PR 4 — fold session/context ownership

Keep #14 serializer semantics. One decision table for bootstrap / incremental / resume / divergence / compaction / contract change / uncertain failure / shutdown. Keep #19 perf: no pre-send `Agent.messages.list()` for transcript watermark; do not re-serialize billed-usage init onto TTFT.

### PR 5 — switch entry; delete dead callers

Delete only with caller proofs (bridge server/run/mcp, live-run handoff branches, duplicate turn orchestration, unreachable OMP-owned replay). Model/usage/cloud modules default keep. Audit `cursor-mcp-timeout-override` against real long-tool timeouts before removal.

## Inherit vs never copy

| OMP / Cursor surface | Policy |
| --- | --- |
| CursorExecHandlers instance | Use host-created instance |
| Public Cursor arg helpers | Import pinned helpers |
| ToolResultMessage / details | Keep host result; convert only at SDK edge |
| execution-resolved marker | Reuse + identity tests |
| UI renderers | Standard events/results only |
| Context reconciliation rules | Semantic fixtures; SDK-expressible range |
| Private protobuf / AgentService / HTTP2 | Never |
| Private conversation checkpoint DB | Never |
| Builtin Cursor discovery/auth transport | Never; SDK catalog + SDK auth |

## Validation (reuse package scripts)

`npm run typecheck`, `npm test`, `npm pack --dry-run`, then existing isolated / local-resume / steering / visual / jsonl smokes. Cloud stays on dedicated smokes with cleanup.

## Cutover status (this branch)

Landed in one PR (plan PR0–2 + partial 3–5):

- `createCursorOmpExtensionCustomTools` + `buildCursorOmpExtensionToolSpecs` + `mergeCursorOmpCustomTools`
- `sendCursorProviderTurn` merges builtin + extension customTools with shared `cursorOnToolResult` / `emitResolvedOmpExecTool` sink
- When `handlers.mcp` exists: `skipPiToolBridge` on session agent (no loopback `pi_tools` MCP); pool key `bridge:skipped-omp-mcp`
- Manifest lists extension OMP names; ask-question guidance also matches `cursor_ask_question` customTool name
- Bridge modules **kept** as opt-in fallback when `handlers.mcp` is absent (and for existing bridge tests)

| Check | Unit | Live still required |
| --- | --- | --- |
| Real tool via `mcp` customTools | yes | host CursorExecHandlers |
| Dynamic active set / onResolved / single effect | yes | hooks + concurrent live |
| Bridge skipped when mcp present | yes | smoke with real OMP session |
| Cancel stops real work | **open** (host signal=undefined) | **hard gate** |
| Long task / ask / subagent | no | yes |
| Full bridge file delete (plan PR5) | deferred | after cancel + ask live go |


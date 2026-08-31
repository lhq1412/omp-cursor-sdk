# OMP × omp-cursor-sdk integration architecture

This document defines the OMP host boundary for `omp-cursor-sdk`. It reflects the independent-provider port against OMP 18.0.11 and `@cursor/sdk` 1.0.27.

The short user guide is [README.md](../README.md). This file is the maintainer source of truth for provider identity, registry ownership, lifecycle adaptation, and upstream synchronization.

## 1. Scope and invariants

`omp-cursor-sdk` runs the official Cursor SDK agent loop as an OMP provider extension. It is not an OpenAI-compatible endpoint adapter.

Load-bearing invariants:

1. The extension owns only the `cursor-sdk` provider and `cursor-sdk` API discriminator.
2. OMP's built-in `cursor` provider, OAuth credentials, model rows, tools, and fallback policy remain untouched.
3. A turn reaches `@cursor/sdk` only with an explicit Cursor SDK API key.
4. Cursor's installed SDK package or official TypeScript SDK documentation is the source of truth for SDK options, events, lifecycle, and result shapes.
5. OMP's model registry owns dynamic-catalog freshness and stale-cache behavior.
6. The extension's raw catalog cache exists only to restore SDK selection metadata that OMP model rows cannot represent.
7. Session stores, agents, live runs, bridges, debug state, and transport overrides are scoped and disposed together.
8. Provider errors and replay output are scrubbed before entering OMP streams, logs, or persistent session entries.

## 2. Package and load boundary

`package.json` declares the OMP-native extension entry:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

OMP 18 loads TypeScript extensions under Bun. The package does not ship or load a generated `dist/` tree.

The `@oh-my-pi/*` runtime packages remain regular dependencies because an installed extension imports their public runtime modules directly. Versions are pinned together at 18.0.11 to avoid cross-package type/runtime skew.

`src/index.ts` is the composition root. It registers session scope first, then agent/session lifecycle, runtime controls, replay/question/skill/bridge surfaces, OMP prompt deduplication, the provider, and finally the process-error guard. Provider modules remain side-effect-light until OMP calls `streamSimple`.

## 3. Independent provider registration

At load, the extension hydrates generated fallback selection metadata and registers:

```ts
pi.registerProvider("cursor-sdk", {
  baseUrl: "https://cursor.com",
  api: "cursor-sdk",
  oauth: createCursorSdkApiKeyLogin(),
  streamSimple: streamCursorLazy,
  fetchDynamicModels: async (apiKey) => {
    const models = await fetchCursorDynamicModels(apiKey);
    return models.length > 0 ? models : fallbackModels;
  },
  // apiKey: "CURSOR_API_KEY" only when that environment key exists
});
```

`streamSimple` is the executable transport. The custom API discriminator prevents OMP from routing these models through an OpenAI-compatible builtin stream.

Provider matching is strict: both `model.provider` and `model.api` must equal `cursor-sdk`. A model from OMP's built-in `cursor` provider is never accepted because its ID happens to match.

### Why fallback models use dynamic discovery

OMP must be able to resolve a configured `cursor-sdk/*` model when auth/network is unavailable. The checked-in generated snapshot supplies that fallback set whenever live discovery is unauthenticated or empty.

The provider deliberately registers no static model overlays. OMP applies native model policies, including the `extendedContext` clamp, to authoritative dynamic rows before caching them; a static runtime overlay with the same ID would be composed later and overwrite that projected window. This behavior is covered against OMP 18's installed `ModelRegistry`.

## 4. Authentication boundary

Accepted sources, in runtime order:

1. The key passed by OMP in provider stream options (`--api-key`, provider config, or saved `cursor-sdk` login).
2. `CURSOR_API_KEY`.
3. OMP's `modelRegistry.getApiKeyForProvider("cursor-sdk")` where a lifecycle command needs registry access.

`/login cursor-sdk` is implemented with OMP's provider OAuth-shaped login contract, but it accepts and stores a Cursor SDK API key; it does not perform Cursor consumer OAuth.

The registration config never uses a fake placeholder key. `apiKey: "CURSOR_API_KEY"` is present only when that environment variable is actually set, allowing OMP to mark the provider available without turning a sentinel into a credential.

Explicitly excluded sources:

- OMP built-in `cursor` credentials
- `CURSOR_ACCESS_TOKEN`
- Cursor Desktop login state
- Cursor Agent CLI login state
- extension-owned plaintext credential files

The extension never opens OMP's credential database directly. OMP owns credential storage and resolver evaluation. Resolver objects are resolved through OMP's API before the SDK receives a string.

OMP performs its own credential preflight before `streamSimple`. That host error names the independent `cursor-sdk` provider and points to `/login` or an API-key environment variable. If a direct provider call reaches the extension without a resolved key, the extension's scrubbed error names `/login cursor-sdk` and `CURSOR_API_KEY`; the provider API exposes no custom host-preflight message field.

Errors pass through canonical sensitive-text scrubbing before display or persistence. Tests cover bearer tokens, cookies, auth headers, API-key query values, and supplied key literals.

## 5. Dynamic model catalog

### 5.1 Fetch and normalize

`fetchCursorDynamicModels()` resolves the `cursor-sdk` API key, calls the installed `Cursor.models.list({ apiKey })`, validates the returned catalog, persists the raw metadata cache, and converts SDK items to OMP `ProviderModelConfig` rows.

Discovery failures are scrubbed and returned as warnings when fallback/cached behavior can continue. A missing key returns the bootstrap set without issuing an unauthenticated SDK request.

### 5.2 Split cache ownership

OMP 18's model discovery manager owns:

- the authoritative model rows
- the 24-hour freshness TTL
- online/offline refresh strategy
- stale rows after transient fetch failures
- SQLite persistence
- provider-scoped refresh

The extension's `cursor-sdk-model-list.json` owns only:

- validated raw SDK `parameters` and `variants`
- restoration of per-model selection metadata before OMP has called the dynamic fetch in the current process
- API-key fingerprint separation
- mode `0600`, atomic replacement, bounded file shape/size, and no-follow safety

The raw cache has no independent TTL and cannot authorize a request. A fingerprint mismatch prevents metadata reuse across credentials.

`/cursor-refresh-models` calls `ctx.modelRegistry.refreshProvider("cursor-sdk", "online")`. `omp models refresh` refreshes all providers through the same OMP registry path.

### 5.3 Selection identities

`shared/cursor-model-selection-identities.mjs` is the canonical identity generator consumed by both runtime discovery and the checked-in snapshot generator.

For each SDK catalog item:

- the base identity is the canonical SDK `model.id`
- exactly two distinct, parseable context sizes collapse onto that base identity; OMP's native `extendedContext` setting selects the smaller or greater SDK value at send time
- every other context catalog keeps the SDK-default base plus explicit non-default `@context` identities
- SDK `aliases` remain raw catalog metadata and are never registered as OMP model rows
- boolean `fast` parameters remain selection metadata; no `@fast` or `@slow` model identities are generated
- speed is resolved independently at send time from Cursor runtime state and defaults

OMP's `:level` suffix remains reserved for host thinking levels. It composes after the provider/model identity, for example `cursor-sdk/gpt-5.5:xhigh`.

The runtime selection map stores the SDK model ID and exact parameter combination separately from OMP's display ID. For converged models, send preparation maps OMP's already-projected effective model window to the matching SDK context tier; no path guesses context parameters from the user-facing string or imports a separate global settings instance.

### 5.4 Context windows

Cursor catalog parameters describe selectable contexts but do not supply every OMP context-budget field. Resolution order is:

1. measured/user overrides from `cursor-sdk-context-windows.json`
2. the bundled context-window map
3. the parseable SDK context size, then the bundled default

Exactly-two-tier rows declare the smaller resolved window as zero-cost `cost.longContext.inputThreshold` metadata. SDK run checkpoints update the key for the context value actually sent, including a context-qualified evidence key for a converged canonical row. Cache/usage math treats nullable OMP `contextWindow` and `maxTokens` defensively.

## 6. Reasoning and speed mapping

OMP thinking metadata is generated from the SDK parameter values exposed by each model:

- SDK `reasoning`, `effort`, or boolean `thinking` controls are selected, not inferred from model names.
- `xhigh` maps to `xhigh` or `extra-high` only when present.
- `max` is exposed only for a distinct SDK `max` value.
- boolean thinking plus effort sends `thinking=false` and omits effort for OMP `off`.
- unsupported OMP levels normalize through the per-model map; they are not sent as invented SDK values.

Fast is Cursor-specific runtime state. Selection precedence is:

1. one-run `--cursor-no-fast` / `--cursor-fast` override
2. session state persisted by `/cursor-fast`
3. configured per-model default
4. SDK default

OMP 18.0.11's built-in `/fast` is hard-wired to fixed OpenAI, Anthropic, and Google service-tier families and exposes no custom-provider family registration hook. `/cursor-fast` therefore remains the canonical control for the independent `cursor-sdk` provider. Cloud status reports fast as not applicable rather than pretending the Cloud API supports the local selection flag.

## 7. Turn and session path

The provider path is deliberately phased:

```text
streamCursor
  → CursorProviderTurnRunner
      → prepare (auth, config, transport, agent acquisition, bridge/live-run setup)
      → send (agent.send wiring and abort listener)
      → finalize (run.wait, replay/drain, artifacts, usage/cache updates)
      → emit (live replay or direct assistant events)
      → cleanup (phase-owned resources)
```

`src/cursor-provider-turn-types.ts` keeps immutable phase data and explicit results. Each phase owns the cleanup it creates; the runner does not duplicate collaborator internals.

### Session identity and lifecycle

`src/cursor-session-scope.ts` derives scope from OMP session cwd, session file/id/name, and generation. That key owns:

- pooled local SDK agent
- per-session SDK SQLite store
- transport-aware pool identity
- send policy and rebootstrap count
- live-run registry and replay queue
- bridge endpoint/run
- agent lineage entries
- debug artifact grouping

OMP lifecycle adaptation:

- `session_start` initializes scope before dependent listeners.
- `before_agent_start` and `turn_start` resynchronize model-scoped surfaces because OMP 18 exposes no extension `model_select` event.
- `session_before_compact` releases scoped live runs and resets the pooled agent before compaction.
- `session_compact` and `session_before_tree` invalidate the current agent.
- `session_tree` resets it after navigation.
- `session_shutdown` always disposes the scope and clears extension-owned HTTP/1.1 state.
- a scope-key change disposes the previous scope before reuse.

The send policy chooses bootstrap or incremental prompts from committed session state. It periodically reboots a long-lived agent and never commits send state before the SDK run has reached the required completion point.

## 8. Tools, replay, skills, and prompt context

### Bridge

For each local run, the extension can expose the active OMP tool snapshot through a loopback MCP server. Names are converted to `pi__*`, schemas are normalized to MCP JSON Schema, calls dispatch back through OMP's tool executor, and abort ownership spans both sides.

Bridge endpoint state is run-scoped. Shutdown rejects pending calls, closes transports, unregisters routes, and removes signal handlers. Diagnostics never print unsanitized headers or tool payloads by default.

### Replay

OMP does not expose wrapped builtin tool definitions that an extension can safely replace and delegate. Therefore the port never registers Cursor wrappers under OMP builtin names such as `read`, `bash`, `edit`, or `write`.

Only the neutral `cursor` replay tool is eligible for registration. Its execution is extension-internal and it renders Cursor SDK activity already recorded by the provider. A registration conflict fails soft: the extension skips the name and retains scrubbed transcript traces.

Tool visibility, aliases, labels, replay side-effect policy, and transcript formatters derive from `src/cursor-tool-presentation-registry.ts`; sibling modules must not maintain competing tool-name tables.

### Skills and project rules

OMP 18 active skills come from `getActiveSkills()` and hidden skills are excluded from Cursor invocation.

For local SDK runs with all Cursor setting sources enabled, the SDK also loads project instruction files. The extension removes only confidently matched OMP `<repo-rules>` entries for the same `AGENTS.md`/`CLAUDE.md` sources. Ambiguous markup is preserved unchanged. Cloud runs preserve the full prompt because the remote environment cannot be assumed to load local files.

## 9. Roles, subagents, and fallback

No provider-specific role layer is needed. OMP resolves `modelRoles` before default, smol, slow, task, advisor, and plan invocations, then selects the registered `cursor-sdk/*` model. Contract tests load OMP 18's installed model resolver and prove `enabledModels` keeps `cursor-sdk` separate from builtin `cursor`, while `@default`, `@smol`, `@slow`, `@task`, and `@plan` retain the provider and thinking suffix. Explicit context suffixes remain available for non-converged catalogs; speed and two-tier context remain separate runtime state.

Fallback is host policy, never extension policy. With default `retry.fallbackChains: {}`, a failed `cursor-sdk/*` model has no cross-provider candidate. Users may explicitly configure a chain such as:

```yaml
retry:
  modelFallback: true
  fallbackChains:
    "cursor-sdk/*": ["cursor/*"]
```

A contract test loads OMP 18's installed fallback resolver and proves both the empty-chain and explicit-chain cases. The extension must not add hidden aliases, retry shims, or credential crossover to simulate fallback.

### Known Cursor SDK contract gaps

The installed `@cursor/sdk@1.0.27` types leave two integrations deliberately blocked:

- `ModelListItem` exposes catalog metadata but no local/cloud availability field, and there is no maintained account-scoped availability preflight. OMP therefore cannot annotate or filter `/model` safely by runtime; `Agent.create()` remains a best-effort catalog check and backend create/send errors are authoritative. Revisit runtime annotations, compatibility warnings, and catalog-drift tests only when the SDK/API exposes authoritative availability metadata; never infer compatibility from catalog size or model parameters.
- `SDKCustomToolContext` exposes only `toolCallId`, with no abort signal, deadline, or cancellation channel. The loopback MCP bridge remains the canonical local OMP-tool transport. Revisit `local.customTools` only if the SDK adds that lifecycle contract or the extension explicitly owns aborts, timeouts, child cleanup, diagnostics, permissions, and equivalent platform-smoke coverage.

## 10. OMP host adaptation boundary

The port imports only `@oh-my-pi/*` host packages. Important host-specific adaptations include:

| Surface | OMP 18 integration |
|---|---|
| Extension manifest | `omp.extensions` |
| Model registry | authoritative `fetchDynamicModels`, with generated fallback rows |
| Dynamic refresh | `refreshProvider(provider, "online")` |
| Provider auth | OAuth-shaped API-key login owned by OMP |
| Model roles | native `modelRoles` and `@role` resolution |
| Fallback | native `retry.fallbackChains` only |
| System prompt | OMP string-array prompt contract |
| Skills | `getActiveSkills()` |
| Project trust | `ctx.isProjectTrusted()`; no extension trust store |
| Model surface resync | `session_start`, `before_agent_start`, `turn_start` |
| Compaction/tree | OMP session lifecycle events |
| Tool schemas | `@oh-my-pi/omptype/typebox` and OMP ToolInfo normalization |
| Native replay | neutral `cursor` tool only; no builtin shadowing |
| Context markup | OMP `<repo-rules>` parser/dedup path |
| Runtime | Bun-native OMP packages and tests |

Do not add a second convention beside these OMP-native surfaces. A future OMP public API should replace a local adapter cleanly rather than be wrapped indefinitely.

## 11. Upstream synchronization strategy

This repository has two upstream lineages: `fitchmultz/pi-cursor-sdk` supplies Cursor SDK runtime/features, while `LoneExile/omp-cursor-sdk` supplies prior OMP-port fixes and reference adaptations. This repository is an OMP 18 port, not a permanent compatibility layer that can merge either upstream's host wiring verbatim.

Maintainer remotes should keep those responsibilities explicit:

```text
origin        -> lhq1412/omp-cursor-sdk
pi-upstream   -> fitchmultz/pi-cursor-sdk
omp-upstream  -> LoneExile/omp-cursor-sdk
```

### Classification

Every upstream change is classified before application:

1. **Cursor runtime core** — SDK selection, send/finalize behavior, usage, errors, stores, live runs, transcript normalization. Port unless the installed SDK contract or current OMP ownership makes it obsolete.
2. **Pi host adapter** — imports, extension events, auth/model registry, tool definitions/renderers, prompt context, settings/session paths. Reimplement against OMP public APIs; never copy a Pi assumption blindly.
3. **Shared generated data** — model identity generator, snapshots, constants. Keep one canonical shared implementation and regenerate deterministic outputs.
4. **Maintainer tooling/docs** — translate commands, artifact paths, package manifests, and smoke gates to OMP; discard Pi-only instructions.

### Sync procedure

For each upstream sync:

1. Record the upstream commit/range being evaluated in the change description or changelog entry.
2. Diff by subsystem, not by whole-tree merge.
3. Verify every changed Cursor SDK assumption against the installed `@cursor/sdk` source/types or official TypeScript SDK documentation.
4. Add/update a focused contract test for external payloads, events, lifecycle, timing, errors, usage, or tool shapes.
5. Port runtime-core changes through the existing OMP collaborators.
6. Reimplement host-adapter changes only where OMP exposes an equivalent contract.
7. Regenerate snapshots and prove generator/runtime identity parity.
8. Run unit/type/package checks and the applicable OMP live platform lanes.
9. Update user docs only for behavior that exists in the current OMP build.

### Conflict policy

- OMP provider identity, credential separation, model-registry ownership, and lifecycle semantics win over Pi compatibility.
- Cursor SDK documented/installed behavior wins over upstream mocks or comments.
- Existing OMP public APIs win over private host imports.
- Clean cutovers win over aliases and deprecated paths.
- If OMP cannot safely support a Pi feature (for example builtin tool shadowing), fail soft or omit the feature explicitly; do not fake delegation.

### Provenance policy

Preserve the original MIT notice and upstream author credit. New OMP-port changes carry the current repository's authorship. Never claim OMP or Cursor SDK code as repository-owned, and do not copy dependency source into the package unless its license and notice requirements are explicitly handled.

## 12. Verification and release gates

Local checks:

```bash
npm test
npm run typecheck
npm run typecheck:tests
npm pack --dry-run
npm run check:cursor-snapshots
npm run check:platform-smoke
```

Provider/runtime release gate:

```bash
npm run smoke:platform:all
```

Cloud runtime changes additionally require:

```bash
npm run smoke:cloud
```

A direct OMP smoke must load the extension source or installed package and resolve an independent ID:

```bash
omp models cursor-sdk -e ./src/index.ts
omp --auto-approve -e ./src/index.ts --model cursor-sdk/composer-2.5 --no-session -p "Reply with OK."
```

OMP's model listing uses `ModelRegistry.getAvailable()`. The provider's authoritative discovery callback returns generated fallback rows without auth, so `cursor-sdk` remains selectable and an attempted turn reaches OMP's `cursor-sdk` credential preflight without exercising the SDK. With auth, live SDK rows replace that fallback result. A live turn smoke requires valid Cursor SDK auth. Release status remains blocked—not skipped-ready—when required auth or platform hosts are unavailable.

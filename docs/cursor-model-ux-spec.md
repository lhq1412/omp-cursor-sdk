# Cursor SDK model UX specification

> Maintainer source of truth for the `cursor-sdk/*` model catalog and selection behavior in OMP 18. User setup belongs in [README.md](../README.md).

## Status

Implemented against OMP 18.0.11 and exact `@cursor/sdk@1.0.30`.

The extension is intentionally independent from OMP's built-in `cursor/*` provider:

- provider: `cursor-sdk`
- custom API discriminator: `cursor-sdk`
- interactive auth: `/login cursor-sdk`
- environment fallback: `CURSOR_API_KEY`
- model examples: `cursor-sdk/composer-2.5`, `cursor-sdk/grok-4.6`, `cursor-sdk/gpt-5.5:xhigh`

Provider, API discriminator, and credential namespace must all remain independent. A matching model ID from another provider is not a Cursor SDK model.

## Goals

- Make Cursor SDK catalog models ordinary OMP models.
- Preserve SDK model IDs and selectable parameter values without inventing model-specific behavior.
- Let OMP own model listing, persistence, roles, thinking syntax, retry, and fallback.
- Keep Cursor-only speed and agent mode explicit extension controls.
- Start with a deterministic fallback catalog, then adopt the live SDK catalog through OMP dynamic discovery.
- Keep catalog/cache failures non-fatal when a safe bootstrap model remains available.

## Sources of truth

Precedence:

1. Installed `@cursor/sdk` runtime and types.
2. Official TypeScript SDK documentation: <https://cursor.com/docs/sdk/typescript>.
3. Captured contract fixtures from that exact installed version.
4. Generated fallback catalog and context-window evidence.
5. Conservative defaults only where the SDK exposes no value.

Never infer an SDK parameter from a model name, vendor family, UI label, or previous Cursor release.

## OMP registry contract

At extension load:

1. Load the generated fallback catalog and restore raw SDK selection metadata from the fingerprint-matched extension cache when valid.
2. Register `cursor-sdk` with `streamSimple` and an authoritative `fetchDynamicModels`, but no static model overlays.
3. Return live SDK rows when available and the generated fallback rows when discovery is unauthenticated or empty.
4. Let OMP's runtime discovery manager apply native model policies, then decide whether to fetch online, use fresh SQLite rows, or retain stale rows.

`/cursor-refresh-models` calls `ctx.modelRegistry.refreshProvider("cursor-sdk", "online")`. The global CLI equivalent is `omp models refresh`.

An empty successful dynamic fetch resolves to the generated fallback rows. Keeping fallback models on the same dynamic path is required: OMP applies native `extendedContext` policy to discovered rows, while a later static runtime overlay would overwrite the projected window.

### Cache ownership

OMP owns:

- authoritative discovered model rows
- 24-hour freshness
- online/offline refresh strategy
- stale-on-transient-failure behavior
- SQLite persistence and registry availability

The extension raw cache owns only:

- SDK `parameters` and `variants` that OMP rows cannot preserve
- API-key fingerprint separation
- pre-fetch selection-map hydration
- bounded validation, mode `0600`, no-follow reads, and atomic replacement

The raw cache does not authorize requests and has no independent TTL. It never stores the API key.

## Canonical selection identities

`shared/cursor-model-selection-identities.mjs` is the single identity implementation for runtime discovery and snapshot generation.

For each catalog item:

1. Find the SDK default variant.
2. Use only the canonical SDK `model.id` as the base identity.
3. Normalize distinct context values without using SDK aliases.
4. When there are exactly two parseable, differently sized contexts, register only the base identity and attach the smaller/greater pair as native extended-context selection metadata.
5. Otherwise, keep the base at the SDK default and emit one `@context` identity for every non-default context.

Example shape for the current catalog:

```text
cursor-sdk/gpt-5.5                 # /extended-context: 272k off, 1m on
cursor-sdk/grok-4.6                # no context control
```

A future three-tier catalog remains explicit:

```text
cursor-sdk/future-model
cursor-sdk/future-model@256k
cursor-sdk/future-model@1m
```

Not generated for the current two-tier GPT-5.5 catalog:

```text
cursor-sdk/gpt-5-5
cursor-sdk/gpt-5.5@272k
cursor-sdk/grok-4.6@fast
cursor-sdk/grok-4.6@slow
cursor-sdk/gpt-5.5@fast
cursor-sdk/gpt-5.5@slow
```

This keeps speed and two-tier context state out of model identity while preserving explicit identities when OMP's boolean native control cannot represent the SDK catalog.

Every registered OMP row has a separate internal selection record containing the SDK model ID and complete SDK parameter list. Send code reads that record plus OMP's native `extendedContext` setting; it does not parse or reconstruct parameters from the OMP ID.

## OMP thinking integration

OMP reserves `:level` for thinking selection. It composes after the provider/model identity:

```text
cursor-sdk/gpt-5.5:xhigh
cursor-sdk/grok-4.6:medium
```

Catalog parameter priority is based on exposed SDK controls, not model family:

1. `reasoning`
2. `effort`
3. boolean `thinking` plus optional effort

Rules:

- Expose only values present in the live/generated catalog.
- Map OMP `xhigh` to SDK `xhigh` or `extra-high` only when present.
- Expose OMP `max` only when the SDK publishes a distinct `max` value.
- Boolean thinking `off` sends `thinking=false` and omits effort.
- Unsupported OMP levels normalize through the generated per-model `thinkingLevelMap`.
- Models without an SDK-controllable reasoning parameter may still emit thinking deltas; their OMP metadata must not claim a control that does not exist.

Cursor's `fast` parameter is not an OMP thinking level. Do not add `:fast`/`:slow` aliases; they collide with OMP's model suffix grammar.

## Speed selection

Effective speed precedence:

1. One-run CLI override: `--cursor-no-fast` or `--cursor-fast`; no-fast wins if both are present.
2. Session override persisted by `/cursor-fast`.
3. Configured per-model default.
4. Built-in local default: off. SDK catalog `defaultFast` metadata does not set runtime state.

Speed is never encoded into the model identity. OMP 18.0.11 exposes built-in `/fast` only for fixed OpenAI, Anthropic, and Google service-tier families and provides no public custom-provider family registration API. Until OMP adds that hook, `/cursor-fast` is the canonical speed control for the independent `cursor-sdk` provider.

The footer uses Cursor-only status (`cursor:local · fast:on|off`). Cloud reports `fast:n/a` because the local SDK selection flag is not assumed to control Cursor Cloud execution.

## Context windows

The SDK catalog exposes context selections but does not provide every context-budget value OMP needs. Resolution order:

1. `~/.omp/agent/cursor-sdk-context-windows.json` measured/user overrides.
2. Bundled checkpoint-derived map.
3. Parsed SDK context size, then the bundled default.

Successful local runs can update the cache from `checkpoint.tokenDetails.maxTokens`. Discovery never probes every model at startup. Cache writes use the context value actually sent to the SDK, such as `gpt-5.5@272k`, even when that tier shares the canonical OMP model ID.

Exactly-two-tier models declare the smaller window as zero-cost `cost.longContext.inputThreshold` metadata and the greater window as their full model budget. OMP clamps the effective model window to that threshold while native `extendedContext` is off; send-time SDK selection maps the effective window OMP passes to the smaller or greater SDK tier. This avoids a second settings singleton and preserves OMP's rule that explicit per-model context-window overrides win.

Context keys use canonical SDK model identities. Alias-specific observations are ignored. Values must remain finite positive integers.

Do not advertise Cursor Max Mode or collapse a context catalog unless the installed SDK exposes the exact parameter values and their sizes can be ordered without guessing.

## Auth and refresh UX

Startup never parses `process.argv`. OMP owns CLI parsing and passes the provider option key to `streamSimple`.

Resolution boundary:

1. OMP stream `options.apiKey`.
2. `CURSOR_API_KEY`.
3. OMP `cursor-sdk` provider key for registry commands.

Missing auth behavior:

- provider registration still succeeds with fallback models
- no placeholder key is registered
- OMP's host credential preflight names `cursor-sdk` and directs the user to `/login` or an API-key environment variable before `streamSimple` runs
- if a direct provider invocation reaches `streamSimple` without a resolved key, the extension returns a scrubbed actionable error naming `/login cursor-sdk` and `CURSOR_API_KEY`
- dynamic refresh does not call `Cursor.models.list()` unauthenticated

Builtin `cursor` OAuth/Desktop credentials are never read or migrated.

## Roles, subagents, and fallback

OMP model roles select the registered IDs directly:

```yaml
modelRoles:
  default: cursor-sdk/composer-2.5
  task: cursor-sdk/grok-4.6
  slow: cursor-sdk/gpt-5.5:xhigh
```

The installed OMP 18 role resolver is contract-tested so `@task` and `@slow` preserve the independent provider and thinking suffix. Explicit context suffixes remain available for non-converged catalogs. Speed and two-tier context state remain separate runtime controls.

There is no implicit cross-provider fallback. Default OMP retry can retry the same model, but `retry.fallbackChains: {}` yields no alternate provider. Users may opt in explicitly:

```yaml
retry:
  modelFallback: true
  fallbackChains:
    "cursor-sdk/*": ["cursor/*"]
```

The installed OMP fallback resolver is contract-tested for both configurations.

## Representative catalog contracts

These examples come from the historical checked-in catalog generated from `@cursor/sdk@1.0.27`; the currently installed SDK baseline is 1.0.30. Regeneration may change them, so tests must change only with recaptured catalog evidence.

### `grok-4.5`

- parameters: `effort`, `fast`
- effort values: `low`, `medium`, `high`
- fast values: `false`, `true`
- generated model identities: base only; speed uses Cursor runtime state

### `grok-4.6`

- parameters: `effort`, `fast`
- effort values: `low`, `medium`, `high`, `xhigh`
- fast values: `false`, `true`
- generated model identities: base only; speed uses Cursor runtime state
- OMP `:xhigh` maps to SDK `effort=xhigh`

## Images and prompt content

Only image bytes from the latest user message are forwarded. Earlier transcript images become an explicit omitted-image placeholder; a later plain-text turn does not silently resend prior bytes. Cursor is instructed to ask for reattachment or description when earlier image data is needed.

Unset `PI_CURSOR_SETTING_SOURCES` omits SDK setting sources and keeps OMP `<repo-rules>`. Local Cursor agents can load Cursor setting sources when opted in. When `PI_CURSOR_SETTING_SOURCES=all`, OMP `<repo-rules>` blocks that confidently duplicate SDK-loaded project/user instruction files are removed before send. Ambiguous markup and cloud runs preserve the original OMP prompt.

## Usage and compaction

Billed `agent.getUsage()` rows populate spend fields only. Occupancy `totalTokens` uses safe per-turn local `turn-ended` usage when it fits the selected context window and is compatible with the latest compaction boundary.

Invariants:

- billed cumulative totals never become context occupancy
- cache fields remain a partition of local input usage
- invalid/negative/non-finite usage is rejected
- stale pre-compaction occupancy cannot restick the footer or trigger immediate recompaction
- cloud raw usage remains display metadata unless a mapped, contract-tested accounting shape exists

## Acceptance criteria

A catalog/selection change is complete only when:

- snapshot generation and runtime identity output match
- the installed SDK source/docs support every parameter claim
- provider matching rejects builtin `cursor/*`
- fallback models survive missing auth and empty dynamic fetches through OMP's authoritative discovery path
- live dynamic models replace fallback rows through OMP's registry
- exactly-two-tier contexts converge under native `extendedContext`; every other context catalog retains explicit non-default `@context` identities
- only canonical SDK `model.id` values are registered; SDK aliases are absent
- no model identity contains `@fast` or `@slow`
- OMP thinking metadata maps only exposed SDK values
- roles and explicit fallback resolve through installed OMP code
- context and usage caches remain credential/session safe
- `npm test`, typechecks, snapshot checks, packaging, and applicable live platform gates pass

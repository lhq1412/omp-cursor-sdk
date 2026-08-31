# omp-cursor-sdk

Independent [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) provider extension backed by the official `@cursor/sdk` agent runtime.

The extension registers models under **`cursor-sdk/*`**. It does not replace, modify, or reuse OMP's built-in **`cursor/*`** provider.

This repository continues the OMP port lineage of [LoneExile/omp-cursor-sdk](https://github.com/LoneExile/omp-cursor-sdk) and ports Cursor runtime features from [fitchmultz/pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk). See [OMP integration architecture](docs/omp-integration.md) for the host boundary and dual-upstream synchronization policy.

## Requirements

- OMP 18.0.11 or newer
- Bun 1.3.14 or newer (OMP and the extension runtime)
- Node.js 22.19 or newer (maintenance scripts)
- a Cursor SDK API key from Cursor Dashboard → API Keys, or a supported team service-account key

The extension currently pins `@cursor/sdk@1.0.27`. It does not reuse Cursor Desktop, Cursor Agent CLI, or OMP built-in Cursor OAuth credentials.

## Install

GitHub release v0.4.2:

```bash
omp plugin install https://github.com/lhq1412/omp-cursor-sdk/releases/download/v0.4.2/omp-cursor-sdk-0.4.2.tgz
```

Git source-archive installation is unsupported because Bun does not materialize `bundledDependencies` from Git archives.

If you previously installed `LoneExile/omp-cursor-sdk`, uninstall the old Git source first because both repositories use the same package name, then run the release command above:

```bash
omp plugin uninstall omp-cursor-sdk
```

From npm after the independent package release:

```bash
omp plugin install omp-cursor-sdk
```

From a local checkout:

```bash
npm install
omp plugin link .
```

The package manifest uses OMP's native `omp.extensions` entry and loads `src/index.ts` directly under Bun. There is no generated `dist/` build step.

## Authenticate

Preferred interactive flow:

1. Start OMP.
2. Run `/login cursor-sdk`.
3. Paste a Cursor SDK API key.
4. Run `/cursor-refresh-models` if the session started before the key was saved.

Environment flow:

```bash
export CURSOR_API_KEY="your-key"
omp --model cursor-sdk/composer-2.5
```

One-shot flow:

```bash
omp --api-key "your-key" --model cursor-sdk/composer-2.5 -p "Reply with OK."
```

Credential boundary:

- OMP resolves `cursor-sdk` login, provider configuration, and `--api-key` credentials.
- `CURSOR_API_KEY` is the explicit environment fallback.
- OMP's built-in `cursor` OAuth and Cursor Desktop/CLI login are never treated as Cursor SDK API keys.
- Keys are not written to `cursor-sdk.json`, model snapshots, debug output, or repository files.

## Models

List or refresh the independent provider catalog:

```bash
omp models cursor-sdk
omp models refresh
```

The extension hydrates its generated fallback catalog immediately, then exposes models only through OMP's authoritative `fetchDynamicModels` path: live SDK rows when available, otherwise the fallback rows. Keeping both sources on that path lets OMP apply native model policies such as `extendedContext` before caching. OMP owns the 24-hour SQLite discovery cache and stale-cache behavior. The extension's `~/.omp/agent/cursor-sdk-model-list.json` stores a validated raw SDK catalog only to hydrate selection metadata before OMP restores its dynamic rows; it is mode `0600`, keyed by an API-key fingerprint, and never contains the key.

### Model IDs

```bash
omp --model cursor-sdk/composer-2.5
omp --model cursor-sdk/gpt-5.5
```

Normalization rules:

- Only the SDK canonical `model.id` is used as the base identity.
- Exactly two distinct, ordered context sizes collapse onto that base identity. OMP's native `/extended-context off` selects the smaller SDK context and `/extended-context on` selects the larger one.
- Context catalogs with one, three or more, or non-orderable values do not collapse. Their base uses the SDK default and each non-default context remains an explicit `@context` row.
- Speed is runtime state, not a model identity; the catalog never generates `@fast` or `@slow` rows. Local fast defaults off unless overridden by CLI, `/cursor-fast` session state, or a configured per-model preference.
- `/cursor-fast`, `--cursor-fast`, and `--cursor-no-fast` map to the SDK's boolean `fast` parameter when the selected model exposes it.
- SDK aliases such as `gpt-5-5` and `composer-2-5` are raw catalog metadata, not OMP model rows.
- The selected OMP ID, native extended-context setting, thinking level, and Cursor fast state map to the SDK's real model ID and parameter list at send time.

For the current two-tier GPT-5.5 catalog, `/extended-context off` sends `context=272k`; `/extended-context on` sends `context=1m`. Successful checkpoint measurements are cached under the selected context-qualified key even though both selections share one OMP model ID.

After upgrading from a catalog that exposed SDK aliases, speed rows, or two-tier context rows, run `omp models refresh` once to replace OMP's cached provider rows. Those stale selectors are unsupported.

### Reasoning

OMP thinking suffixes and `--thinking` map to SDK `reasoning`, `effort`, or boolean `thinking` values only when the live catalog exposes them:

```bash
omp --model cursor-sdk/gpt-5.5:xhigh
omp --model cursor-sdk/claude-opus-4-7:high
omp --model cursor-sdk/gpt-5.5 --thinking medium
```

`xhigh` maps to SDK `xhigh` or `extra-high`; `max` is exposed only when the SDK publishes a distinct `max` value. For Claude-style boolean thinking plus effort, OMP thinking `off` sends `thinking=false` and removes `effort`.

## OMP model roles and subagents

`cursor-sdk/*` models are ordinary OMP registry models. Assign them directly to built-in or custom roles in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: cursor-sdk/composer-2.5
  task: cursor-sdk/grok-4.6
  slow: cursor-sdk/gpt-5.5:xhigh
  plan: cursor-sdk/claude-opus-4-7:high
```

OMP subagents that select `@task`, `@slow`, or another configured role resolve to the exact independent provider ID and thinking suffix. Explicit context suffixes remain valid for non-converged context catalogs. Speed and two-tier context selection follow their separate Cursor/OMP runtime controls. No provider-specific subagent shim is required.

## Provider fallback

The extension has **no implicit fallback** to OMP's built-in `cursor` provider or any other provider. OMP fallback routing remains available only through explicit host configuration.

Example opt-in fallback to a same-named built-in Cursor model:

```yaml
retry:
  modelFallback: true
  fallbackChains:
    "cursor-sdk/*":
      - "cursor/*"
```

OMP skips wildcard targets that do not expose the current model ID. Prefer concrete selectors when providers use different IDs. Leaving `retry.fallbackChains` empty preserves fail-on-provider-error behavior after OMP's normal same-model retries.

## Runtime controls

Local runtime is the default. Useful commands and flags:

```text
/cursor-fast
/cursor-mode agent
/cursor-mode plan
/cursor-http on
/cursor-refresh-config
/cursor-refresh-models
/cursor-runtime
/cursor-tools
/cursor-cloud
```

```bash
omp --model cursor-sdk/grok-4.6 --cursor-fast
omp --model cursor-sdk/grok-4.6 --cursor-no-fast
omp --model cursor-sdk/grok-4.6 --cursor-mode plan
omp --model cursor-sdk/grok-4.6 --cursor-http1
```

OMP 18.0.11 exposes built-in `/fast` only for its fixed OpenAI, Anthropic, and Google service-tier families; it has no public custom-provider family registration API. The independent `cursor-sdk` provider therefore keeps `/cursor-fast` as its canonical speed control until OMP exposes a safe integration hook.

Non-secret defaults live in `~/.omp/agent/cursor-sdk.json` or a trusted project's `.omp/cursor-sdk.json`. Project reads and writes follow OMP 18's `ctx.isProjectTrusted()` result; the extension does not implement a second trust model.

Cursor Cloud remains explicit opt-in and fail-closed. It requires acknowledgement, a valid Git repository state, and Cloud-compatible credentials. `/cursor-cloud` owns list/archive/delete lifecycle operations. Live Cloud probes must verify cleanup of every created `bc-*` agent.

## Tools, skills, and context

- Cursor's native agent loop remains intact.
- Active OMP tools can be exposed to local Cursor agents through the run-scoped loopback MCP bridge as `pi__*` tools.
- `cursor_ask_question` and the active OMP skill registry are bridged when enabled.
- OMP built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` definitions are never shadowed. OMP exposes metadata for those tools, not wrapped definitions that an extension can safely delegate to.
- The extension registers only the neutral `cursor` replay tool for Cursor SDK activity cards. If another extension owns that name, registration is skipped and scrubbed transcript traces remain available.
- For local Cursor runs with `PI_CURSOR_SETTING_SOURCES=all`, overlapping OMP `<repo-rules>` entries for project `AGENTS.md`/`CLAUDE.md` are removed before send because the Cursor SDK loads those sources itself. Ambiguous markup is preserved unchanged. Cloud runs preserve the complete OMP prompt.

See [Cursor tool surfaces](docs/cursor-tool-surfaces.md) and [native replay](docs/cursor-native-tool-replay.md) for detailed controls.

## Session behavior

Local agents are pooled by OMP session scope, cwd, transport, model selection, and tool surface. Persisted sessions use isolated Cursor SDK SQLite stores. Resume, compaction, tree navigation, shutdown, abort, incomplete tool replay, and usage accounting remain session-scoped.

Debug capture is opt-in:

```bash
PI_CURSOR_SDK_EVENT_DEBUG=1 omp --model cursor-sdk/composer-2.5
```

Raw debug artifacts can contain prompts, tool arguments/results, and local paths. They remain under gitignored `.debug/`; do not publish them.

## Development and verification

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```

OMP packages are Bun-targeted (`Bun.env`, `import.meta.dir`, native loaders), so runtime tests use Bun. `test/setup-bun.ts` supplies only missing Vitest-compatibility helpers; production code has no test shims.

Provider/runtime changes also require the platform release gate:

```bash
npm run smoke:platform:all
```

That gate covers packed installs on macOS, Ubuntu, and Windows. Cloud execution changes additionally require:

```bash
npm run smoke:cloud
```

See [platform smoke](docs/platform-smoke.md) and [live smoke checklist](docs/cursor-live-smoke-checklist.md).

## Provenance and license

- Original Cursor SDK runtime project: [fitchmultz/pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk), Copyright © 2026 Mitch Fultz.
- Prior OMP port lineage: [LoneExile/omp-cursor-sdk](https://github.com/LoneExile/omp-cursor-sdk).
- Current OMP 18 port and independent-provider work: [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk), Copyright © 2026 lhq1412.
- Repository code is MIT licensed; see [LICENSE](LICENSE).
- OMP and `@cursor/sdk` are separate dependencies distributed under their own licenses and are not relicensed by this repository.
- Cursor is a trademark of Anysphere, Inc. This project is not affiliated with or endorsed by Anysphere.

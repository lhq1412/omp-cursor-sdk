# Cursor native tool visual audit

Visual claims require ANSI, rendered HTML/PNG, and matching session JSONL from the same run. Text-only tests do not prove OMP TUI card layout, color, expansion, or diff rendering.

The required cross-platform release evidence is produced by [the platform smoke gate](./platform-smoke.md). This workflow is for focused inner-loop review.

## Baseline

- OMP 18.0.11.
- `@cursor/sdk` 1.0.30.
- Bun 1.3.14 or newer.
- Provider/model under test: `cursor-sdk/grok-4.6`.
- Native replay enabled.
- Fresh session and output directories.

OMP replay uses one neutral `cursor` tool. Do not expect extension-registered `read`, `bash`, `edit`, or `write` wrappers. JSONL must use `toolCall.name: "cursor"` for SDK activity and retain the source identity in result details.

## Capture

```bash
OUT="$(mktemp -d /tmp/omp-cursor-sdk-visual.XXXXXX)"

npm run smoke:visual -- \
  --ext "$PWD" \
  --cwd "$PWD" \
  --model cursor-sdk/grok-4.6 \
  --label read-package \
  --prompt 'Read ./package.json with your file tool, then answer with only the package name.' \
  --out-dir "$OUT"
```

The runner writes:

- `<label>.ansi`;
- `<label>.txt`;
- `<label>.html`;
- `<label>.png` unless `--no-screenshot`;
- `<label>.jsonl.path`;
- a visual manifest.

The parent process resolves OMP, Node, tmux, and environment paths before launch. The run uses an isolated OMP agent directory and clears debug environment variables unless explicitly enabled.

## Required matrix

| Evidence | Prompt intent | JSONL requirement | Visual requirement |
| --- | --- | --- | --- |
| Read | Read `package.json` | `toolName=cursor`, `sourceToolName=read`, success | Path/summary and package content are readable |
| Grep | Search README for `omp-cursor-sdk` | `toolName=cursor`, `sourceToolName=grep`, success | Search summary and match are readable |
| Find | Find `README.md` | `toolName=cursor`, `sourceToolName=find`, success | Match path is readable |
| Shell success | Print `cursor visual smoke` | `toolName=cursor`, `sourceToolName=bash`, success | Output is visible and not error-styled |
| Write/edit | Write then edit a temp file | `toolName=cursor`, structured edit/write details | Diff or file preview is legible |
| Shell failure | Exit nonzero with known text | `toolName=cursor`, error | Failure is visibly distinct |
| Footer | Local Cursor run | provider status | Default OMP footer remains intact |

Configured MCP, web, plan, todo, task, and image activity use neutral cards and are additional evidence only when the SDK actually emits those events.

## Review procedure

1. Open the PNG and HTML.
2. Confirm the captured terminal is non-empty and styled.
3. Check collapsed and expanded content where applicable.
4. Compare the card with the matching JSONL call/result IDs.
5. Confirm SDK replay uses `cursor`, while OMP bridge calls use the real OMP tool name.
6. Confirm edit additions/removals use the expected colors and line numbers.
7. Scan artifacts for credentials and tokenized loopback URLs.

Do not count prompt text as a rendered card. The detector anchors card/output patterns and correlates each visual item with a JSONL result requirement.

## Bridge audit

Run bridge evidence separately:

```bash
npm run smoke:visual -- \
  --bridge \
  --expose-builtin-tools \
  --model cursor-sdk/grok-4.6 \
  --label bridge-read \
  --prompt 'Call pi__read on ./package.json, then report the package name.' \
  --out-dir "$OUT"
```

Expected JSONL identity is the real `read` tool, not `cursor`.

## Self-test

The offline environment/PATH probe requires no Cursor call:

```bash
node scripts/visual-tui-smoke.mjs --self-test
```

It must prove:

- a resolved OMP path is used instead of a hostile PATH entry;
- the OMP agent directory is isolated;
- native replay and bridge defaults are explicit;
- debug variables are cleared unless opted in;
- missing session JSONL is rejected.

## Release gate

Focused screenshots are not release evidence by themselves. Provider/runtime changes must finish with:

```bash
npm run smoke:platform:all
```

The gate captures PTY/ConPTY output on macOS, Ubuntu, and Windows native, renders host-side xterm evidence, correlates JSONL, and scans artifacts.

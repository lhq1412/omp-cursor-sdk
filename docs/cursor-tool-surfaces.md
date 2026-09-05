# Cursor tool surfaces in OMP

`omp-cursor-sdk` runs `cursor-sdk/*` models through `@cursor/sdk`. One OMP session can expose three distinct tool surfaces.

## Surface map

| Surface | Owner | Callable by Cursor | OMP history/display |
| --- | --- | --- | --- |
| Cursor SDK host tools | Cursor local agent | Yes | Recorded activity replayed through the neutral `cursor` tool |
| Cursor-configured MCP | Cursor settings and plugins | Yes, when loaded | Neutral `cursor` activity |
| OMP bridge (`pi__*`) | This extension's loopback MCP server | Yes, when exposed | The real OMP tool name and result |

The `pi__` prefix is a stable bridge protocol identity inherited from the Cursor SDK integration. It does not mean that OMP's builtin `cursor` provider is active.

## Cursor SDK host tools

Cursor's local agent owns file, shell, search, edit, planning, web, task, and configured MCP execution. OMP does not execute those calls.

Completed SDK activity is display-only replay:

- the extension registers one replay-only OMP tool named `cursor`;
- it never shadows OMP's `read`, `bash`, `edit`, `write`, `grep`, `find`, or `ls`;
- the replay result retains `details.sourceToolName`;
- consuming an unknown replay ID fails instead of executing real work.

Disable replay cards:

```bash
PI_CURSOR_NATIVE_TOOL_DISPLAY=0 omp --model cursor-sdk/grok-4.6
```

## OMP bridge

For local runs, the extension can expose bridgeable active OMP tools through a run-scoped, tokenized loopback MCP endpoint. Cursor sees names such as `pi__cursor_ask_question` or `pi__my_extension_tool`; OMP executes the underlying tool.

Overlapping OMP builtins are hidden by default because Cursor already has host equivalents. Explicitly expose them only when the prompt requires OMP execution:

```bash
PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1 omp --model cursor-sdk/grok-4.6
```

Other controls:

```bash
# Disable only interactive questions.
PI_CURSOR_ASK_QUESTION=0 omp --model cursor-sdk/grok-4.6

# Disable the complete OMP bridge.
PI_CURSOR_PI_TOOL_BRIDGE=0 omp --model cursor-sdk/grok-4.6

# Bound one bridged call below the effective SDK MCP timeout.
PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS=120000 omp --model cursor-sdk/grok-4.6

# Disable the bootstrap callable-surface manifest.
PI_CURSOR_TOOL_MANIFEST=0 omp --model cursor-sdk/grok-4.6
```

OMP's `--no-tools`, `--tools`, and `--exclude-tools` change the active OMP registry and therefore the bridge snapshot. They do not disable Cursor SDK host tools or Cursor-configured MCP servers.

## Cursor settings and MCP

Unset `PI_CURSOR_SETTING_SOURCES` omits SDK `settingSources`, so ambient Cursor user/project settings, rules, plugins, and MCP configuration are not loaded. Opt in with `PI_CURSOR_SETTING_SOURCES=all` or a comma list such as `user,project`:

```bash
PI_CURSOR_SETTING_SOURCES=all omp --model cursor-sdk/grok-4.6
```

## Cloud runtime

Cursor Cloud does not use the local OMP bridge or local replay continuation. Cloud execution is configured with `/cursor-runtime cloud` and guarded by cloud preflight and lifecycle cleanup.

## Debugging identity

Persisted OMP tool calls have two valid shapes:

- SDK replay: `toolCall.name === "cursor"` and, when available, `toolResult.details.sourceToolName` names the SDK activity.
- OMP bridge: `toolCall.name` and `toolResult.toolName` are the real OMP tool name.

Do not infer execution from assistant prose. Verify `toolCall`/`toolResult` entries in the session JSONL.

## Security boundary

- The bridge binds to `127.0.0.1` and uses run-scoped endpoint tokens.
- Tool schemas come from OMP's callable omptype schemas and are converted to JSON Schema for MCP.
- Bridge errors and diagnostics are scrubbed.
- `PI_CURSOR_SDK_EVENT_DEBUG=1` writes raw local artifacts that may contain prompts, paths, arguments, and results; never commit them.

Detailed replay behavior: [Cursor native tool replay](./cursor-native-tool-replay.md).

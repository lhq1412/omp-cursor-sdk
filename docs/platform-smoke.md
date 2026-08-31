# Platform smoke gate

This is the release gate for `omp-cursor-sdk` changes that affect local Cursor provider/runtime, transport, sessions, bridge, replay, or extension wiring:

```bash
npm run smoke:platform:all
```

Cloud runtime execution changes additionally require:

```bash
npm run smoke:cloud
```

Implementation details: [Platform smoke implementation reference](./platform-smoke-implementation.md).

## Release contract

Required targets:

1. `macos` — native macOS through Crabbox static SSH.
2. `ubuntu` — Crabbox local container.
3. `windows-native` — Windows 11 through Parallels and ConPTY.

The release-gate entrypoint runs required targets sequentially to avoid shared host, Crabbox lease, filesystem, and Cursor API contention. Total wall time is therefore additive across required targets.

Every target must pass every required suite. Missing auth, Docker, Crabbox, SSH, Parallels, Bun, Node, browser rendering, or target setup is a doctor/gate failure. No target may be marked skipped-ready.

## Prerequisites

Host:

- Node 24 or newer for the configured release matrix (the package engine minimum remains 22.19.0).
- Bun 1.3.14 or newer.
- npm.
- Crabbox 0.26.0 or newer.
- Docker for Ubuntu.
- SSH access to the configured macOS work root.
- Parallels access to `pi-extension-windows-template` / `crabbox-ready`.
- Playwright Chromium and xterm assets for host rendering.
- `CURSOR_API_KEY` for live suites.

Target workspaces must also have Node, npm, and Bun. Maintainer orchestration runs under Node; the OMP CLI entry runs under Bun.

Validate prerequisites without spending Cursor calls:

```bash
npm run smoke:platform:doctor
```

## Commands

```bash
# Help and suite inventory
npm run smoke:platform

# One target
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
npm run smoke:platform:windows-native

# Required complete matrix
npm run smoke:platform:all
```

Optional environment overrides:

```bash
PLATFORM_SMOKE_CRABBOX="/path/to/crabbox"
PLATFORM_SMOKE_MAC_HOST="localhost"
PLATFORM_SMOKE_MAC_USER="$USER"
PLATFORM_SMOKE_MAC_WORK_ROOT="/Users/$USER/crabbox/omp-cursor-sdk"
PLATFORM_SMOKE_UBUNTU_IMAGE="registry.example.com/ubuntu-node24-crabbox:latest"
PLATFORM_SMOKE_WINDOWS_VM="pi-extension-windows-template"
PLATFORM_SMOKE_WINDOWS_SNAPSHOT="crabbox-ready"
PLATFORM_SMOKE_WINDOWS_USER="<windows-user>"
PLATFORM_SMOKE_WINDOWS_NATIVE_WORK_ROOT="C:\\crabbox\\omp-cursor-sdk"
```

## Configuration

`platform-smoke.config.mjs` is the source of truth:

```js
export default {
  packageName: "omp-cursor-sdk",
  cursorModel: "cursor-sdk/grok-4.6",
  artifactRoot: ".artifacts/platform-smoke",
  requiredTargets: ["macos", "ubuntu", "windows-native"],
  ubuntuContainerImage: "omp-cursor-sdk-platform-node-bun:24.16-1.3.14-root",
  ubuntuContainerBaseImage: "cimg/node:24.16",
  ubuntuContainerBunImage: "oven/bun:1.3.14",
  nodeValidationMajor: 24,
  bunValidationMinimum: "1.3.14",
  windowsParallels: {
    sourceVm: "pi-extension-windows-template",
    snapshot: "crabbox-ready",
    workRoot: "C:\\crabbox\\omp-cursor-sdk",
  },
};
```

The Ubuntu wrapper changes only the configured base image user to `root` so Crabbox can bootstrap SSH/Git/rsync/curl. An explicit `PLATFORM_SMOKE_UBUNTU_IMAGE` must already satisfy that contract.

## Required suites

### Build and package

`platform-build` proves on each target:

- `npm ci`;
- `npm run check:platform-smoke`;
- `npm test`;
- `npm run typecheck`;
- `npm pack`;
- packed tarball install;
- OMP project plugin install/list from the packed package;
- no generated `dist/` requirement;
- no secret or unsafe artifact.

The packed extension uses `omp.extensions: ["./src/index.ts"]`. Live suites install it with:

```bash
omp plugin install --scope project <packed-package-path>
omp plugin list --scope project
```

No live suite validates the checkout through stale generated output.

### Native visual matrix

`cursor-native-visual-matrix` performs one bounded prompt that exercises read, grep, find, shell success, write/edit, and shell failure.

Required identity:

- SDK activity uses OMP `toolCall.name === "cursor"`;
- successful results retain `details.sourceToolName`;
- OMP builtins are not shadowed;
- ANSI/HTML/PNG evidence matches session JSONL.

### HTTP/1.1

`cursor-http1-live` proves the opt-in local HTTP/1.1/SSE path, one provider turn, and visible transport status.

### Bridge visual matrix

`cursor-bridge-visual-matrix` performs exactly three bridge calls: `pi__bash`, successful `pi__read`, and failing `pi__read`.

Required identity:

- OMP history uses real `bash`/`read` names;
- bridge diagnostics correlate calls without exposing endpoint tokens or credentials;
- successful and failed cards are visually distinct.

### Abort cleanup

`cursor-abort-cleanup` starts long-running bridge work, aborts the OMP turn, and proves child, bridge endpoint, live-run, and session-agent cleanup.

### Local resume lanes

Each lane uses the same target-local packed package preparation and extracts session/debug/runtime evidence:

```bash
npm run smoke:platform -- run cursor-local-resume-restart
npm run smoke:platform -- run cursor-local-resume-safety
npm run smoke:platform -- run cursor-local-resume-tool-surface
npm run smoke:platform -- run cursor-local-resume-abort
npm run smoke:platform -- run cursor-local-resume-tree
npm run smoke:platform -- run cursor-local-resume-copy-switch
npm run smoke:platform -- run cursor-local-resume-fallback
npm run smoke:platform -- run cursor-local-resume-compaction
npm run smoke:platform -- run cursor-local-resume-default-dry-run
npm run smoke:platform -- run cursor-local-resume-cleanup
```

These prove restart reuse, clone/fork safety, tool-surface invalidation, abort handling, tree navigation, copied-session rejection, missing-agent fallback, compaction generation, default/opt-out precedence, and recorded-ID-only cleanup.

OMP 18 session continuation uses `--session-dir` and `--continue`. The removed `--session-id` flag must not appear.

## Target execution

One Crabbox lease is warmed per target and reused sequentially for that target's suites.

Live suites:

1. prepare or reuse a packed npm install;
2. create a suite-local workspace and isolated `PI_CODING_AGENT_DIR`;
3. install/list the packed OMP plugin at project scope;
4. launch `@oh-my-pi/pi-coding-agent/dist/cli.js` with Bun through PTY/ConPTY;
5. pass the prompt as one positional interactive message;
6. wait for final marker and session JSONL;
7. capture ANSI and structured artifacts;
8. bundle bounded, redacted evidence for host extraction.

`PI_OFFLINE=1` disables unrelated startup network probes without disabling the explicit live Cursor provider call. `OMP_SKIP_SETUP=1` prevents the first-run setup wizard from consuming the injected prompt in the suite-local agent directory.

## Visual evidence

Targets capture the real terminal stream. The host:

1. parses the bounded artifact bundle;
2. renders ANSI through the canonical xterm/Playwright path;
3. writes HTML and PNG;
4. detects required card/output patterns;
5. correlates each visual item with its JSONL result requirement.

Prompt text alone cannot satisfy a card detector. A visual assertion passes only when both rendered evidence and matching JSONL pass.

## Artifacts

Root:

```text
.artifacts/platform-smoke/
```

Each run records:

- target/suite command and exit status;
- dependency and package output;
- packed tarball identity;
- plugin install/list output;
- terminal ANSI/plain text;
- rendered HTML/PNG;
- session JSONL path/content summary;
- provider/debug metadata;
- bridge diagnostics where required;
- artifact manifest, assertions, and failures.

`latest.json` points at the latest completed run. Retention is bounded by count and age.

## Artifact transport safety

The platform artifact contract enforces:

- canonical relative paths only;
- no symlink traversal;
- no-follow regular-file opens;
- bounded file count, per-file bytes, aggregate bytes, path bytes, and inflated bundle bytes;
- canonical base64;
- checksum and exact-size verification;
- descriptor-relative POSIX extraction with rollback;
- fail-closed Windows controller extraction where safe handle-relative mutation is unavailable;
- redaction and post-write secret scans.

Never include:

- `CURSOR_API_KEY`;
- bearer/cookie/auth headers;
- tokenized bridge URLs;
- raw credential-bearing Git URLs;
- legacy or current OMP credential stores;
- unbounded raw SDK event directories.

## Cloud release gate

`npm run smoke:cloud` is separate and paid. It creates a private throwaway GitHub repository and proves cancel, explicit repository/starting-ref branch reporting, direct push, missing-ref fail-closed behavior, lifecycle deletion, usage/artifact observation, and destructive cleanup.

Every created Cloud agent/run ID must be retained, archived/deleted, and independently verified absent. The throwaway repository must return authenticated 404 after deletion.

The cloud gate does not replace the local three-target matrix.

## Release bar

Passing means:

- doctor passed;
- all required suites passed on all required targets;
- packed extension identity is `omp-cursor-sdk`;
- provider/model identity is `cursor-sdk/...`;
- visual and JSONL assertions agree;
- no required artifact is missing;
- redaction/security scans pass;
- no live process, bridge endpoint, agent, or throwaway cloud resource remains.

Anything less is blocked or failed, not release-ready.

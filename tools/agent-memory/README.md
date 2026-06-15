# agent-memory — Layer 0 work-log CLI

Versioned, source-controlled implementation of the per-agent **Layer 0 — Role
Work-Log** described in the `para-memory-files` skill. Replaces the previously
hand-placed `/usr/local/bin/agent-memory` binary so the CLI ships durably with
the agent base image.

## Contents

| File | Purpose |
|---|---|
| `agent-memory` | The CLI (bash, `set -euo pipefail`). Current version `1.1.0`. |
| `VERSION` | Plain-text version, must match `AGENT_MEMORY_VERSION` in the script. |
| `install.sh` | Idempotent installer: `install -m 0755` the script to `/usr/local/bin`. |
| `Dockerfile.snippet` | Base-image build step that copies this dir and runs `install.sh`. |

## Install (base image)

Add `Dockerfile.snippet` to the agent base image Dockerfile. On build it copies
`tools/agent-memory` to `/opt/agent-memory` and runs `install.sh`, which places
the binary and prints the version as a build-time smoke check.

Override the destination with `AGENT_MEMORY_BIN=/custom/path ./install.sh`.

## Commands

```
agent-memory read [--n N]   ROLLING SUMMARY + last N RECENT LOG entries (default 10)
agent-memory append         Append one structured entry from stdin (date stamped)
agent-memory compact        Move oldest entries to archive.md; emit them to stdout
agent-memory init <role>    Seed memory.md from role template if absent (idempotent)
agent-memory version        Print CLI version
```

Roles: `content-researcher`, `editorial-writer`, `fact-checker`,
`video-producer`, `cmo`, `cco`, `ceo`, `cto`, `engineer` (9 total). Unknown
roles fall back to a generic executive template.

Operates on `$AGENT_HOME/memory.md` + `$AGENT_HOME/archive.md`
(`$AGENT_HOME` defaults to `$HOME`).

## Compaction contract

- `MAX_ENTRIES=40`, `KEEP_ENTRIES=10`.
- `append` auto-compacts when RECENT LOG exceeds 40 entries: the oldest
  `(count − 10)` entries move to `archive.md`, 10 are kept, and a
  `<!-- SUMMARY-UPDATE-NEEDED -->` marker is inserted at the top of RECENT LOG.
- The semantic fold (archived entries → ROLLING SUMMARY, then clear the marker)
  is done by the agent, with the weekly CTO-owned `memory-compaction` routine as
  a backstop for idle agents. See `memory-compaction-routine-spec.md`.

## Versioning

Bump both `VERSION` and `AGENT_MEMORY_VERSION` in `agent-memory` together. The
installer surfaces the running version so base-image builds fail loudly on a
mismatched or missing binary.

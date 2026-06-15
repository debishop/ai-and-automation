#!/usr/bin/env bash
# install.sh — durable installer for the agent-memory CLI.
# Idempotent: copies the versioned script to a system bin and marks it executable.
# Intended to be invoked from the agent base image build (see Dockerfile.snippet),
# not run by hand. Re-running is safe and simply re-syncs the binary.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SRC_DIR/agent-memory"
DEST="${AGENT_MEMORY_BIN:-/usr/local/bin/agent-memory}"

if [[ ! -f "$SRC" ]]; then
  echo "install.sh: source not found at $SRC" >&2
  exit 1
fi

install -m 0755 "$SRC" "$DEST"

installed_version="$("$DEST" version 2>/dev/null || echo 'unknown')"
echo "agent-memory installed at $DEST ($installed_version)"

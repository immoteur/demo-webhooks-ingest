#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "[preflight] $*" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  fail "Missing \`docker\` (install Docker + Docker Compose)"
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "Missing \`docker compose\` (Docker Compose v2 plugin)"
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker daemon is not running (start Docker Desktop / system service)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${SCRIPT_DIR}/../bin/node"

NODE_MAJOR="$("${NODE}" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 20 ]]; then
  fail "Node.js 20+ required (found: $("${NODE}" -v 2>/dev/null || echo 'unknown'))"
fi

echo "[preflight] OK"

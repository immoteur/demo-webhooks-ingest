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

if ! command -v node >/dev/null 2>&1; then
  fail "Missing \`node\` (Node.js 20+ required)"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 20 ]]; then
  fail "Node.js 20+ required (found: $(node -v 2>/dev/null || echo 'unknown'))"
fi

echo "[preflight] OK"


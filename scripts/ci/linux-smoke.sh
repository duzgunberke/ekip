#!/usr/bin/env bash
# The smoke test on Linux with an English locale, in a throwaway container: what the fresh-install CI
# runs first. Run it before merging to main (needs Docker); it takes about two minutes.
#   bash scripts/ci/linux-smoke.sh [ref, default HEAD]
set -euo pipefail
cd "$(dirname "$0")/../.."
ref="${1:-HEAD}"
dir=$(mktemp -d /tmp/ekip-linux-smoke.XXXXXX)
trap 'git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"' EXIT
git worktree add -q --detach "$dir" "$ref"
docker run --rm -v "$dir:/w" -w /w -e LANG=C.UTF-8 node:22-bookworm-slim bash -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq git procps >/dev/null 2>&1
  git config --global --add safe.directory /w
  bash scripts/smoke.sh > /tmp/smoke.log 2>&1; s=$?
  if [ $s -ne 0 ]; then grep -v "\"jsonrpc\"" /tmp/smoke.log | tail -40; fi
  exit $s' && echo "linux smoke: ok"

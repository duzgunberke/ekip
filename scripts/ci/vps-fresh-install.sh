#!/usr/bin/env bash
# ekip's own CI on the user's server: a fresh install of a git ref inside an isolated container that
# runs its own Docker daemon (docker-in-docker), so the memory stack the test starts never touches the
# server's real services or ports. /var/lib/docker inside is a volume: overlay on overlay does not mount. Same checks as .github/workflows/fresh-install.yml.
#   vps-fresh-install.sh <repo url> <ref> <result.json>
set -uo pipefail
repo="$1"; ref="$2"; out="$3"
name="ekip-ci-$(date +%s)"
log="$(dirname "$out")/ci-$(date +%Y%m%d-%H%M%S).log"
started=$(date -u +%FT%TZ)
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

result() { # status, step
  local sha; if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then sha=${ref:0:7}; else sha=$(git ls-remote "$repo" "$ref" 2>/dev/null | head -1 | cut -c1-7); fi
  python3 - "$out" "$1" "$2" "$sha" "$ref" "$started" "$log" <<'PY'
import json, sys, datetime
out, status, step, sha, ref, started, log = sys.argv[1:]
tail = open(log, errors="ignore").read()[-6000:] if log else ""
json.dump({"status": status, "step": step, "sha": sha, "ref": ref, "startedAt": started,
           "finishedAt": datetime.datetime.utcnow().isoformat() + "Z", "log": tail}, open(out, "w"))
PY
}
step() { echo "== $1" | tee -a "$log"; }
run() { docker exec "$name" bash -lc "$1" >> "$log" 2>&1; }

step "isolated machine"
docker run -d --privileged -v /var/lib/docker --cpus 2 --memory 6g --name "$name" ubuntu:24.04 sleep infinity >> "$log" 2>&1 || { result fail "isolated machine"; exit 1; }
run 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git sqlite3 tmux curl ca-certificates docker.io python3 sudo >/dev/null
(dockerd > /var/log/dockerd.log 2>&1 &) ; for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; docker info >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null
npm i -g @anthropic-ai/claude-code >/dev/null 2>&1; node -v; claude --version | head -1' || { result fail "prerequisites"; exit 1; }

step "clone $ref and ekip init"
run "git clone -q '$repo' /root/ekip && cd /root/ekip && git checkout -q '$ref' && git log -1 --format='%h %s' && timeout 2400 node plugin/bin/ekip.js init --no-keys < /dev/null" || { result fail "ekip init"; exit 1; }

step "memory stack up and patched"
run 'for i in $(seq 1 40); do curl -sf http://127.0.0.1:8420/health >/dev/null && break; sleep 5; done; curl -sf http://127.0.0.1:8420/health >/dev/null
grep -q "LANGUAGE (strict" /root/ekip/data/tdai/patched/app/src/core/prompts/l1-extraction.ts' || { result fail "memory stack"; exit 1; }

step "memory-core reaches the free pool (facts and vectors need it; Linux needs host-gateway)"
run 'C=$(docker ps --format "{{.Names}}" | grep -m1 -E "^tdai-memory-core(-|$)"); docker exec $C node -e "fetch(\"http://host.docker.internal:3001/health\").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"' || { result fail "memory-core to free pool"; exit 1; }

step "smoke test"
run 'cd /root/ekip && bash scripts/smoke.sh' || { result fail "smoke test"; exit 1; }

step "doctor"
run 'cd /root/ekip; timeout 300 node plugin/bin/ekip.js doctor > /tmp/doctor.out 2>&1; s=$?; cat /tmp/doctor.out
! grep -Eqi "Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|TypeError|ReferenceError" /tmp/doctor.out && { [ $s -le 1 ] || [ $s -eq 124 ]; }' || { result fail "doctor"; exit 1; }

step "PASS"
result pass "all"

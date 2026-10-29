#!/usr/bin/env bash
# A fresh install on a throwaway clean machine (OrbStack Ubuntu), the same checks as
# .github/workflows/fresh-install.yml: for releases when CI is not available.
#   scripts/fresh-install-test.sh [git ref, default main] [repo url, default this checkout's origin]
set -euo pipefail
ref="${1:-main}"
repo="${2:-$(git -C "$(dirname "$0")/.." remote get-url origin)}"
vm="ekip-check-$(date +%s)"
command -v orb >/dev/null || { echo "needs OrbStack (orb)"; exit 2; }
cleanup() { orb delete -f "$vm" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== clean machine $vm"
orb create ubuntu "$vm" >/dev/null
# orb runs commands in the Mac's current folder (shared disk): start every step in the VM's own home
in_vm() { orb run -m "$vm" bash -lc "cd ~ && $1"; }

echo "== prerequisites"
# a fresh machine runs its own package updates at first boot: wait for the dpkg lock, retry, fail loudly
in_vm 'set -e; for i in $(seq 1 60); do sudo fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break; sleep 5; done
for i in 1 2 3; do sudo apt-get update -qq >/dev/null 2>&1 && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git sqlite3 tmux curl ca-certificates docker.io >/dev/null 2>&1 && break; sleep 10; done
command -v docker >/dev/null || { echo "docker.io did not install"; exit 1; }
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
sudo apt-get install -y -qq nodejs >/dev/null 2>&1
sudo systemctl start docker 2>/dev/null || sudo service docker start >/dev/null
sudo chmod 666 /var/run/docker.sock
sudo npm i -g @anthropic-ai/claude-code >/dev/null 2>&1
node -v && docker --version && claude --version | head -1'

echo "== clone $repo @ $ref and ekip init"
in_vm "git clone -q '$repo' ekip && cd ekip && git checkout -q '$ref' && git log -1 --format='%h %s' && timeout 1800 node plugin/bin/ekip.js init --no-keys < /dev/null"

echo "== memory stack up and patched"
in_vm 'for i in $(seq 1 30); do curl -sf http://127.0.0.1:8420/health >/dev/null && break; sleep 5; done
curl -sf http://127.0.0.1:8420/health >/dev/null && echo "memory-core healthy"
grep -q "LANGUAGE (strict" ~/ekip/data/tdai/patched/app/src/core/prompts/l1-extraction.ts && echo "patches applied"'

echo "== memory-core reaches the free pool"
in_vm 'C=$(docker ps --format "{{.Names}}" | grep -m1 -E "^tdai-memory-core(-|$)"); docker exec $C node -e "fetch(\"http://host.docker.internal:3001/health\").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && echo "free pool reachable from memory-core"'

echo "== smoke test"
in_vm 'cd ~/ekip && bash scripts/smoke.sh > /tmp/smoke.log 2>&1 && echo "smoke ok" || { tail -30 /tmp/smoke.log; exit 1; }'

echo "== doctor"
in_vm 'cd ~/ekip && set +e; timeout 300 node plugin/bin/ekip.js doctor > /tmp/doctor.out 2>&1; s=$?; tail -20 /tmp/doctor.out
if grep -Eqi "Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|TypeError|ReferenceError" /tmp/doctor.out; then exit 1; fi
[ $s -le 1 ] || [ $s -eq 124 ]'

echo "== PASS: fresh install of $ref"

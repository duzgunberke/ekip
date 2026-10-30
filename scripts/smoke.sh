#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export EKIP_HOME="$tmp/home"
mkdir -p "$EKIP_HOME"
run() {
  local out status
  if out=$(timeout 20s node "$@" 2>&1); then status=0; else status=$?; fi
  printf '%s\n' "$out"
  if grep -Eqi 'Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError' <<<"$out"; then return 1; fi
  return "$status"
}
echo '== pool capacity test =='; node plugin/lib/workers/agents.test.mjs
echo '== terminal back ends =='; node plugin/lib/core/terminal.test.mjs
for cmd in help version agents tasks 'mesai status'; do echo "== $cmd =="; run plugin/bin/ekip.js $cmd; done
printf '%s\n' '== task lifecycle =='
out=$(node plugin/bin/ekip.js task new smoke --steps 'a; b' 2>&1); printf '%s\n' "$out"; [[ ! "$out" =~ (Cannot\ find\ module|ERR_MODULE_NOT_FOUND|SyntaxError) ]]
id=$(head -1 <<<"$out" | tr -d '\r')
[[ -n "$id" ]]
run plugin/bin/ekip.js task step "$id" 1 done
run plugin/bin/ekip.js task done "$id"
printf '%s\n' '== task result, question, status digest =='
id=$(node plugin/bin/ekip.js task new digest --steps 'a; b' | head -1 | tr -d '\r')
run plugin/bin/ekip.js task ask "$id" "Devam edilsin mi?" --option Evet --option Hayır
EKIP_LANG=tr run plugin/bin/ekip.js status --offline | tee "$tmp/status.out"
for part in 'Şimdi çalışan' 'Senden beklenen (1)' 'Takılan' 'Son 24 saatte biten' 'ekip sürümü ve yayın' 'A) Evet'; do grep -q "$part" "$tmp/status.out"; done
run plugin/bin/ekip.js task answer "$id" Evet
run plugin/bin/ekip.js task done "$id" "Özet hazır" --link docs/commands.md --link https://example.com/x
EKIP_LANG=tr run plugin/bin/ekip.js status --offline | tee "$tmp/status.out"
grep -q 'Sonuç: Özet hazır' "$tmp/status.out"; grep -q 'https://example.com/x' "$tmp/status.out"; grep -q 'Senden beklenen (0)' "$tmp/status.out"
echo '== hub release endpoint test =='; node --test hub/src/release.test.mjs
for args in 'review --project x --dry-run' 'dev ls'; do
  echo "== $args (expected config error) =="
  read -r -a parts <<< "$args"
  set +e
  out=$(node plugin/bin/ekip.js "${parts[@]}" 2>&1); status=$?
  set -e
  printf '%s\n' "$out"
  [[ "$out" != *"Cannot find module"* && "$out" != *"ERR_MODULE_NOT_FOUND"* && "$out" != *SyntaxError* ]]
  if [[ "$args" == review* ]]; then grep -q 'registered project required' <<<"$out"; fi
done
for args in 'skill candidates' 'project ls' 'stats --local'; do
  echo "== $args =="; read -r -a parts <<< "$args"; run plugin/bin/ekip.js "${parts[@]}"
done
echo '== doctor (20s cap) =='
set +e
timeout 20s node plugin/bin/ekip.js doctor >"$tmp/doctor.out" 2>&1
status=$?
set -e
cat "$tmp/doctor.out"
# doctor exits 1 when it finds setup issues (expected on a fresh machine); only a crash fails the smoke test
[[ $status -le 1 || $status -eq 124 ]]
if grep -Eqi 'Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError' "$tmp/doctor.out"; then exit 1; fi
for p in plugin/lib/prompt-context.js plugin/lib/memory/prompt-context.js; do
  echo "== prompt context / $p =="
  printf '{"prompt":"hello world test","cwd":"/tmp"}\n' | run "$p"
done
for p in plugin/lib/mcp.js plugin/lib/memory/mcp.js; do
    echo "== MCP tools/list / $p =="
    printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | timeout 3s node "$p" >"$tmp/mcp.out" 2>"$tmp/mcp.err" || status=$?
    cat "$tmp/mcp.out"; cat "$tmp/mcp.err" >&2
    if grep -Eqi 'Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError' "$tmp/mcp.out" "$tmp/mcp.err"; then exit 1; fi
    grep -q '"tools"' "$tmp/mcp.out"
done

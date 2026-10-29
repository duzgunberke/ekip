#!/usr/bin/env bash
set -euo pipefail

patterns=(
  'hf_''[A-Za-z0-9]{30,}'
  'sk-''[A-Za-z0-9]{20,}'
  'ghp_''[A-Za-z0-9]{30,}'
)
key_begin='-----BEGIN .*'
key_end='PRIVATE KEY-----'
patterns+=("${key_begin}${key_end}")
if [[ -f .privacy-denylist ]]; then
  while IFS= read -r pattern || [[ -n "$pattern" ]]; do
    [[ -z "$pattern" || "$pattern" == \\#* ]] && continue
    patterns+=("$pattern")
  done < .privacy-denylist
fi

status=0
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] || continue
  for pattern in "${patterns[@]}"; do
    if grep -nE -- "$pattern" "$file"; then
      printf 'privacy-check: %s matched in %s\n' "$pattern" "$file" >&2
      status=1
    fi
  done
done < <(git ls-files -z)
exit "$status"

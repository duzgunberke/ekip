#!/usr/bin/env bash
# After main passed the fresh-install test: the next version from the commits merged since the last
# tag (major: "major:"/"BREAKING"; minor: "feat"/"minor:"; else patch), version files and CHANGELOG.md
# updated in a "release: vX.Y.Z" commit, tagged, pushed, and a GitHub release with the same notes.
#   release.sh <repo url> <tested sha> <file holding a GitHub token with push access>
set -euo pipefail
repo="$1"; tested="$2"; token=$(cat "$3")
slug=$(echo "$repo" | sed -E 's#https://github.com/##; s#\.git$##')
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone -q "https://x-access-token:${token}@github.com/${slug}.git" "$work/r"; cd "$work/r"
[ "$(git rev-parse HEAD)" = "$tested" ] || { echo "main moved past the tested commit; the next run releases"; exit 0; }
last=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
range=${last:+$last..}HEAD
subjects=$(git log --no-merges --format=%s "$range" | grep -v '^release: v' || true)
[ -n "$subjects" ] || { echo "nothing new since $last"; exit 0; }
cur=${last#v}; cur=${cur:-0.0.0}; IFS=. read -r ma mi pa <<< "$cur"
if echo "$subjects" | grep -Eqi '^(major|breaking)|BREAKING CHANGE'; then next="$((ma+1)).0.0"
elif echo "$subjects" | grep -Eqi '^(feat|minor)[:(!]'; then next="$ma.$((mi+1)).0"
else next="$ma.$mi.$((pa+1))"; fi
notes=$(echo "$subjects" | sed 's/^/- /')
python3 - "$next" <<'PY'
import json, sys
v = sys.argv[1]
for f in ("plugin/.claude-plugin/plugin.json", "package.json"):
    try: d = json.load(open(f))
    except FileNotFoundError: continue
    d["version"] = v; open(f, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
{ printf '## v%s (%s)\n\n%s\n\n' "$next" "$(date -u +%F)" "$notes"; cat CHANGELOG.md 2>/dev/null || true; } > CHANGELOG.new && mv CHANGELOG.new CHANGELOG.md
git -c user.name="ekip release" -c user.email="release@ekip.invalid" commit -qam "release: v$next"
git tag -a "v$next" -m "v$next"
git push -q origin HEAD:main "v$next"
body=$(python3 -c 'import json,sys; print(json.dumps({"tag_name": sys.argv[1], "name": sys.argv[1], "body": sys.argv[2]}))' "v$next" "$notes")
curl -sf -o /dev/null -X POST -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${slug}/releases" -d "$body" || echo "tag pushed; GitHub release page not created"
echo "released v$next"

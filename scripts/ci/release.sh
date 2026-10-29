#!/usr/bin/env bash
# After a commit on main passed the fresh-install test: tag exactly that commit as the next version
# and publish a GitHub release with the commit subjects since the last tag. No release commit, so a
# merge that lands while the test runs never blocks or races the release; the version comes from the
# tag (ekip reads `git describe`). Bump: "major:"/"BREAKING" major, "feat"/"minor:" minor, else patch.
#   release.sh <repo url> <tested sha> <file holding a GitHub token with push access>
set -euo pipefail
repo="$1"; tested="$2"; token=$(cat "$3")
slug=$(echo "$repo" | sed -E 's#https://github.com/##; s#\.git$##')
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
git clone -q "https://x-access-token:${token}@github.com/${slug}.git" "$work/r"; cd "$work/r"
git cat-file -e "$tested^{commit}" || { echo "tested commit $tested not found"; exit 1; }
git tag --points-at "$tested" | grep -q '^v' && { echo "$tested is already released"; exit 0; }
last=$(git describe --tags --abbrev=0 --match 'v*' "$tested" 2>/dev/null || echo "")
subjects=$(git log --no-merges --format=%s ${last:+$last..}"$tested" | grep -v '^release: v' || true)
[ -n "$subjects" ] || { echo "nothing new since $last"; exit 0; }
cur=${last#v}; cur=${cur:-0.0.0}; IFS=. read -r ma mi pa <<< "$cur"
if echo "$subjects" | grep -Eqi '^(major|breaking)|BREAKING CHANGE'; then next="$((ma+1)).0.0"
elif echo "$subjects" | grep -Eqi '^(feat|minor)[:(!]'; then next="$ma.$((mi+1)).0"
else next="$ma.$mi.$((pa+1))"; fi
notes=$(echo "$subjects" | sed 's/^/- /')
git -c user.name="ekip release" -c user.email="release@ekip.invalid" tag -a "v$next" -m "v$next" -m "$notes" "$tested"
git push -q origin "v$next"
body=$(python3 -c 'import json,sys; print(json.dumps({"tag_name": sys.argv[1], "name": sys.argv[1], "body": sys.argv[2]}))' "v$next" "$notes")
curl -sf -o /dev/null -X POST -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${slug}/releases" -d "$body" || echo "tag pushed; GitHub release page not created"
echo "released v$next at ${tested:0:7}"

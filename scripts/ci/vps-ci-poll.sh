#!/usr/bin/env bash
# Run from cron on the server (every 15 min): when main has a new commit, run the fresh-install test
# once for it; when it passes and a token file is given, release it (release.sh). Work happens on
# branches; every merge to main that passes becomes a release. One run at a time.
#   vps-ci-poll.sh <repo url> <dir for state, logs and results> [branch, default main] [token file]
set -uo pipefail
# bash reads a script while it runs: updating these files during a 20-minute test corrupted the run.
# Every run works from its own copy, so the scripts can be replaced at any time.
if [ -z "${EKIP_CI_SNAP:-}" ]; then
  snap=$(mktemp -d /tmp/ekip-ci.XXXXXX); cp "$(cd "$(dirname "$0")" && pwd)"/*.sh "$snap"/
  EKIP_CI_SNAP="$snap" exec bash "$snap/$(basename "$0")" "$@"
fi
trap 'rm -rf "$EKIP_CI_SNAP"' EXIT
repo="$1"; dir="$2"; branch="${3:-main}"; token="${4:-}"
mkdir -p "$dir"
exec 9>"$dir/.lock"; flock -n 9 || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
sha=$(git ls-remote "$repo" "refs/heads/$branch" | cut -c1-40)
[ -n "$sha" ] || exit 0
[ "$(cat "$dir/last-sha" 2>/dev/null)" = "$sha" ] && exit 0
echo "$sha" > "$dir/last-sha"
# the release commit itself only bumps versions: tested already, nothing to release
mirror="$dir/mirror.git"
[ -d "$mirror" ] || git clone -q --bare "$repo" "$mirror"
git -C "$mirror" fetch -q origin "+refs/heads/$branch:refs/heads/$branch" 2>/dev/null
case "$(git -C "$mirror" log -1 --format=%s "$sha" 2>/dev/null)" in "release: v"*) exit 0;; esac
bash "$here/vps-fresh-install.sh" "$repo" "$sha" "$dir/result.json"   # exactly the commit that gets released
if [ -n "$token" ] && grep -q '"status": "pass"' "$dir/result.json"; then
  bash "$here/release.sh" "$repo" "$sha" "$token" >> "$dir/release.log" 2>&1 || echo "$(date -u +%FT%TZ) release failed for $sha" >> "$dir/release.log"
fi
ls -1t "$dir"/ci-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f   # keep the last 20 logs

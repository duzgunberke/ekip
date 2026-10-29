#!/usr/bin/env bash
# Run from cron on the server (every 15 min): when the watched branch has a new commit, or a release
# tag appeared, run the fresh-install test once for it. One run at a time.
#   vps-ci-poll.sh <repo url> <dir for state, logs and results> [branch, default main]
set -uo pipefail
repo="$1"; dir="$2"; branch="${3:-main}"
mkdir -p "$dir"
exec 9>"$dir/.lock"; flock -n 9 || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
sha=$(git ls-remote "$repo" "refs/heads/$branch" | cut -c1-40)
[ -n "$sha" ] || exit 0
[ "$(cat "$dir/last-sha" 2>/dev/null)" = "$sha" ] && exit 0
echo "$sha" > "$dir/last-sha"
bash "$here/vps-fresh-install.sh" "$repo" "$branch" "$dir/result.json"
ls -1t "$dir"/ci-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f   # keep the last 20 logs

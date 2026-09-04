#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
script="$repo_root/scripts/sync-personal-branches.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_ancestor() {
  git -C "$work" merge-base --is-ancestor "$1" "$2" || fail "$1 is not an ancestor of $2"
}

git init --bare "$tmp/upstream.git" >/dev/null
git init --bare "$tmp/fork.git" >/dev/null
git init -b dev "$tmp/seed" >/dev/null
git -C "$tmp/seed" config user.name Test
git -C "$tmp/seed" config user.email test@example.com
printf 'base\n' > "$tmp/seed/shared.txt"
git -C "$tmp/seed" add shared.txt
git -C "$tmp/seed" commit -m base >/dev/null
base=$(git -C "$tmp/seed" rev-parse HEAD)
git -C "$tmp/seed" remote add upstream "$tmp/upstream.git"
git -C "$tmp/seed" remote add fork "$tmp/fork.git"
git -C "$tmp/seed" push upstream dev >/dev/null
git -C "$tmp/seed" push fork dev:personal/deploy >/dev/null

git -C "$tmp/seed" switch -c analytics "$base" >/dev/null
printf 'analytics\n' > "$tmp/seed/analytics.txt"
git -C "$tmp/seed" add analytics.txt
git -C "$tmp/seed" commit -m analytics >/dev/null
git -C "$tmp/seed" push fork HEAD:personal/extended-analytics >/dev/null

git -C "$tmp/seed" switch dev >/dev/null
printf 'upstream-one\n' > "$tmp/seed/upstream.txt"
git -C "$tmp/seed" add upstream.txt
git -C "$tmp/seed" commit -m upstream-one >/dev/null
git -C "$tmp/seed" push upstream dev >/dev/null

work="$tmp/work"
git clone --branch personal/deploy "$tmp/fork.git" "$work" >/dev/null
git -C "$work" config user.name Test
git -C "$work" config user.email test@example.com
git -C "$work" remote add upstream "$tmp/upstream.git"
git -C "$work" fetch origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null
git -C "$work" fetch upstream '+refs/heads/dev:refs/remotes/upstream/dev' >/dev/null

stable_before=$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/deploy)
analytics_before=$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/extended-analytics)
output="$tmp/output"
(cd "$work" && GITHUB_OUTPUT="$output" bash "$script")

assert_ancestor upstream/dev sync-stable
assert_ancestor sync-stable sync-experimental
assert_ancestor origin/personal/extended-analytics sync-experimental
assert_eq "$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/deploy)" "$stable_before"
assert_eq "$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/extended-analytics)" "$analytics_before"
git --git-dir="$tmp/fork.git" show-ref --verify --quiet refs/heads/personal/experimental && fail 'preparation pushed the experimental branch'
grep -qx 'changed=true' "$output" || fail 'first run did not report changed=true'

git -C "$work" push --atomic origin refs/heads/sync-stable:refs/heads/personal/deploy refs/heads/sync-experimental:refs/heads/personal/experimental >/dev/null
git -C "$work" fetch origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null
: > "$output"
(cd "$work" && GITHUB_OUTPUT="$output" bash "$script")
grep -qx 'changed=false' "$output" || fail 'current branches did not report changed=false'

git -C "$work" switch -C personal-change origin/personal/deploy >/dev/null
printf 'personal\n' > "$work/shared.txt"
git -C "$work" add shared.txt
git -C "$work" commit -m personal-conflict >/dev/null
git -C "$work" push origin HEAD:personal/deploy >/dev/null

git -C "$tmp/seed" switch dev >/dev/null
printf 'upstream\n' > "$tmp/seed/shared.txt"
git -C "$tmp/seed" add shared.txt
git -C "$tmp/seed" commit -m upstream-conflict >/dev/null
git -C "$tmp/seed" push upstream dev >/dev/null

git -C "$work" fetch origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null
git -C "$work" fetch upstream '+refs/heads/dev:refs/remotes/upstream/dev' >/dev/null
stable_before=$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/deploy)
experimental_before=$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/experimental)
if (cd "$work" && bash "$script" >/dev/null 2>&1); then
  fail 'conflicting upstream and personal commits unexpectedly composed'
fi
assert_eq "$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/deploy)" "$stable_before"
assert_eq "$(git --git-dir="$tmp/fork.git" rev-parse refs/heads/personal/experimental)" "$experimental_before"

echo 'PASS: personal branch composition is local, atomic-ready, repeatable, and conflict-safe'

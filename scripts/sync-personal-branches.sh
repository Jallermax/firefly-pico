#!/usr/bin/env bash
set -Eeuo pipefail

stable_ref=${STABLE_REF:-origin/personal/deploy}
upstream_ref=${UPSTREAM_REF:-upstream/dev}
analytics_ref=${ANALYTICS_REF:-origin/personal/extended-analytics}
experimental_ref=${EXPERIMENTAL_REF:-origin/personal/experimental}
stable_candidate=${STABLE_CANDIDATE:-sync-stable}
experimental_candidate=${EXPERIMENTAL_CANDIDATE:-sync-experimental}

if [ -n "$(git status --porcelain)" ]; then
  echo 'ERROR: branch sync requires a clean checkout' >&2
  exit 1
fi

for ref in "$stable_ref" "$upstream_ref" "$analytics_ref"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "ERROR: required ref does not exist: $ref" >&2
    exit 1
  fi
done

original_branch=$(git symbolic-ref --quiet --short HEAD || true)
original_commit=$(git rev-parse HEAD)

restore_checkout() {
  if [ -n "$original_branch" ]; then
    git switch --quiet "$original_branch"
  else
    git switch --quiet --detach "$original_commit"
  fi
}

on_error() {
  status=$?
  git merge --abort >/dev/null 2>&1 || true
  restore_checkout >/dev/null 2>&1 || true
  exit "$status"
}
trap on_error ERR

git switch --quiet --force-create "$stable_candidate" "$stable_ref"
git merge --no-edit "$upstream_ref"
stable_sha=$(git rev-parse HEAD)

if git rev-parse --verify --quiet "$experimental_ref^{commit}" >/dev/null; then
  git switch --quiet --force-create "$experimental_candidate" "$experimental_ref"
else
  git switch --quiet --force-create "$experimental_candidate" "$stable_candidate"
fi
git merge --no-edit "$stable_candidate"
git merge --no-edit "$analytics_ref"
experimental_sha=$(git rev-parse HEAD)

stable_current=$(git rev-parse "$stable_ref")
experimental_current=$(git rev-parse --verify --quiet "$experimental_ref^{commit}" || true)
changed=false
if [ "$stable_sha" != "$stable_current" ] || [ "$experimental_sha" != "$experimental_current" ]; then
  changed=true
fi

restore_checkout
trap - ERR

echo "stable candidate: $stable_sha"
echo "experimental candidate: $experimental_sha"
echo "changed: $changed"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "changed=$changed"
    echo "stable_sha=$stable_sha"
    echo "experimental_sha=$experimental_sha"
  } >> "$GITHUB_OUTPUT"
fi

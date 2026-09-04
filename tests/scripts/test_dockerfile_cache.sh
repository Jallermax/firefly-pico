#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
dockerfile="$repo_root/Dockerfile"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

npm_ci_line=$(grep -n -m1 'RUN npm ci --ignore-scripts' "$dockerfile" | cut -d: -f1)
version_line=$(grep -n -m1 'RUN echo \$APP_VERSION > /var/www/html/VERSION' "$dockerfile" | cut -d: -f1)
frontend_commit_line=$(grep -n -m1 'NUXT_PUBLIC_COMMIT_SHA="\$APP_VERSION"' "$dockerfile" | cut -d: -f1 || true)

[ -n "$npm_ci_line" ] || fail 'frontend dependency installation is missing'
[ -n "$version_line" ] || fail 'embedded application version is missing'
[ -n "$frontend_commit_line" ] || fail 'frontend commit SHA is not embedded separately'
[ "$npm_ci_line" -lt "$version_line" ] || fail 'APP_VERSION invalidates the frontend dependency cache'
if grep -q 'NUXT_PUBLIC_VERSION="\$APP_VERSION"' "$dockerfile"; then
  fail 'commit SHA replaces the upstream application version'
fi
if grep -q '^RUN npm prune' "$dockerfile"; then
  fail 'runtime packaging repeats a dependency-tree rewrite after every build'
fi
grep -q -- '--exclude=\./node_modules' "$dockerfile" || fail 'root frontend dependencies are included in the runtime image'

echo 'PASS: commit version changes preserve dependency layers and runtime packaging excludes the build tree'

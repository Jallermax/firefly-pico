#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
dockerfile="$repo_root/Dockerfile"
nuxt_config="$repo_root/front/nuxt.config.ts"
release_workflow="$repo_root/.github/workflows/docker-image.yml"
dev_workflow="$repo_root/.github/workflows/docker-image-dev.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

npm_ci_line=$(grep -n -m1 'RUN npm ci --ignore-scripts' "$dockerfile" | cut -d: -f1)
version_line=$(grep -n -m1 'APP_REVISION:-\$APP_VERSION' "$dockerfile" | cut -d: -f1 || true)
revision_arg_line=$(grep -n -m1 'ARG APP_REVISION' "$dockerfile" | cut -d: -f1 || true)
commit_arg_line=$(grep -n -m1 'ARG APP_COMMIT_SHA' "$dockerfile" | cut -d: -f1 || true)
frontend_version_line=$(grep -n -m1 'NUXT_PUBLIC_VERSION="\$APP_VERSION" NUXT_PUBLIC_COMMIT_SHA="\$APP_COMMIT_SHA"' "$dockerfile" | cut -d: -f1 || true)
upstream_version_line=$(grep -n -m1 'echo "\$APP_VERSION" > /var/www/html/UPSTREAM_VERSION' "$dockerfile" | cut -d: -f1 || true)
back_archive_line=$(grep -n -m1 'app-back.tar.gz' "$dockerfile" | cut -d: -f1 || true)

[ -n "$npm_ci_line" ] || fail 'frontend dependency installation is missing'
[ -n "$version_line" ] || fail 'embedded application version is missing'
[ -n "$revision_arg_line" ] || fail 'deployment revision build argument is missing'
[ -n "$commit_arg_line" ] || fail 'commit SHA build argument is missing'
[ -n "$frontend_version_line" ] || fail 'upstream version and personal commit SHA are not embedded separately'
[ -n "$upstream_version_line" ] || fail 'upstream release channel is not available to the backend'
[ "$npm_ci_line" -lt "$version_line" ] || fail 'APP_VERSION invalidates the frontend dependency cache'
[ "$npm_ci_line" -lt "$upstream_version_line" ] || fail 'upstream version invalidates the frontend dependency cache'
[ "$upstream_version_line" -lt "$back_archive_line" ] || fail 'upstream version is missing from the backend runtime archive'
grep -q 'version: process.env.NUXT_PUBLIC_VERSION ?? pkg.version' "$nuxt_config" || fail 'runtime version does not preserve the upstream image version'
grep -q 'APP_COMMIT_SHA=${{ github.sha }}' "$release_workflow" || fail 'release images do not embed the exact commit SHA'
grep -q 'APP_COMMIT_SHA=${{ github.sha }}' "$dev_workflow" || fail 'dev images do not embed the exact commit SHA'
if grep -q '^RUN npm prune' "$dockerfile"; then
  fail 'runtime packaging repeats a dependency-tree rewrite after every build'
fi
grep -q -- '--exclude=\./node_modules' "$dockerfile" || fail 'root frontend dependencies are included in the runtime image'

echo 'PASS: commit version changes preserve dependency layers and runtime packaging excludes the build tree'

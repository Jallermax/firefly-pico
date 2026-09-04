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

[ -n "$npm_ci_line" ] || fail 'frontend dependency installation is missing'
[ -n "$version_line" ] || fail 'embedded application version is missing'
[ "$npm_ci_line" -lt "$version_line" ] || fail 'APP_VERSION invalidates the frontend dependency cache'

echo 'PASS: commit version changes preserve the frontend dependency layer'

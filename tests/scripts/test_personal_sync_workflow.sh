#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
workflow="$repo_root/.github/workflows/personal-sync.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$workflow" ] || fail 'personal sync workflow is missing'
grep -q 'workflow_dispatch:' "$workflow" || fail 'manual trigger is missing'
grep -q 'cron:.*0 6 \* \* \*' "$workflow" || fail 'daily 06:00 UTC trigger is missing'
grep -q 'contents: write' "$workflow" || fail 'contents write permission is missing'
grep -q 'scripts/sync-personal-branches.sh' "$workflow" || fail 'tested composition script is not used'
grep -q 'TodoReviewUtils.test.js' "$workflow" || fail 'TODO Inbox tests are not gated'
grep -q 'AnalyticsForecastUtils.test.js' "$workflow" || fail 'analytics tests are not gated'
[ "$(grep -c 'npm run build' "$workflow")" -eq 2 ] || fail 'both candidates must build'
grep -q 'git push --atomic origin' "$workflow" || fail 'publication is not atomic'
if grep -Eq 'git push[^#]*(--force|-f([[:space:]]|$))' "$workflow"; then
  fail 'workflow contains a force push'
fi
if grep -Eq '^[[:space:]]+(push|pull_request):' "$workflow"; then
  fail 'sync workflow has an unapproved push or pull-request trigger'
fi

echo 'PASS: sync workflow is scheduled, manual, gated, and atomically non-force publishing'

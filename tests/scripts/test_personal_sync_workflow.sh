#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
workflow="$repo_root/.github/workflows/personal-sync.yml"
agents="$repo_root/AGENTS.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$workflow" ] || fail 'personal sync workflow is missing'
[ -f "$agents" ] || fail 'repository instructions are missing'
grep -q 'workflow_dispatch:' "$workflow" || fail 'manual trigger is missing'
grep -q 'cron:.*0 6 \* \* \*' "$workflow" || fail 'daily 06:00 UTC trigger is missing'
grep -q 'contents: write' "$workflow" || fail 'contents write permission is missing'
grep -q 'scripts/sync-personal-branches.sh' "$workflow" || fail 'tested composition script is not used'
grep -q 'TodoReviewUtils.test.js' "$workflow" || fail 'TODO Inbox tests are not gated'
grep -q 'VersionLinks.test.js' "$workflow" || fail 'personal version links are not gated'
grep -q 'NUXT_PUBLIC_COMMIT_SHA=' "$workflow" || fail 'candidate builds do not embed their exact commit SHA'
grep -q 'tests/scripts/verify_built_version.sh' "$workflow" || fail 'compiled version links are not verified'
grep -q 'AnalyticsForecastUtils.test.js' "$workflow" || fail 'analytics tests are not gated'
[ "$(grep -c 'npm run build' "$workflow")" -eq 2 ] || fail 'both candidates must build'
grep -q 'uses: actions/setup-node@v4' "$workflow" || fail 'Node setup and npm cache are missing'
grep -q 'cache: npm' "$workflow" || fail 'npm download cache is missing'
grep -q 'npm ci --prefer-offline --no-audit --no-fund' "$workflow" || fail 'dependency install is not optimized'
grep -q 'STABLE_LOCK=' "$workflow" || fail 'stable dependency lock is not recorded'
grep -q 'experimental_lock.*!=.*STABLE_LOCK' "$workflow" || fail 'experimental dependencies are not reused safely'
grep -q 'git push --atomic origin' "$workflow" || fail 'publication is not atomic'
grep -q 'personal/deploy' "$agents" || fail 'stable personal branch is not documented'
grep -q 'personal/experimental' "$agents" || fail 'experimental personal branch is not documented'
grep -q 'personal/extended-analytics' "$agents" || fail 'experimental analytics input is not documented'
grep -q 'scripts/sync-personal-branches.sh' "$agents" || fail 'native personal sync command is not documented'
if grep -Eq 'git push[^#]*(--force|-f([[:space:]]|$))' "$workflow"; then
  fail 'workflow contains a force push'
fi
if grep -Eq '^[[:space:]]+(push|pull_request):' "$workflow"; then
  fail 'sync workflow has an unapproved push or pull-request trigger'
fi

echo 'PASS: sync workflow is scheduled, manual, gated, and atomically non-force publishing'

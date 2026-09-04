#!/usr/bin/env bash
# Verify that a compiled personal build contains its exact revision and both version link targets.
set -euo pipefail

usage() {
  echo 'Usage: verify_built_version.sh COMMIT_SHA [NUXT_OUTPUT_DIR]' >&2
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { usage; exit 2; }

commit_sha=$1
output_dir=${2:-front/.output}

[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'COMMIT_SHA must be an exact lowercase 40-character Git SHA'
[ -d "$output_dir" ] || fail "Nuxt output directory does not exist: $output_dir"

grep -R -F -q -- "$commit_sha" "$output_dir" || fail 'compiled output does not contain the commit SHA'
grep -R -F -q -- 'https://github.com/cioraneanu/firefly-pico/releases' "$output_dir" || fail 'compiled output does not contain the upstream releases link'
grep -R -F -q -- 'https://github.com/Jallermax/firefly-pico' "$output_dir" || fail 'compiled output does not contain the personal repository link'

echo "PASS: compiled version links contain $commit_sha"

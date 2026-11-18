#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: bash scripts/run-browser-test.sh node tests/<suite>.cjs" >&2
  exit 2
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
exec 9<tests
if ! flock --nonblock 9; then
  echo "A browser test is already running in this checkout." >&2
  exit 1
fi

export NODE_PATH="${NODE_PATH:-$PWD/client/node_modules}"
mkdir -p eya-server/target
TMPDIR=$(mktemp -d "$PWD/eya-server/target/eya-browser-test.XXXXXX")
export TMPDIR
scope=
cleanup() {
  if [[ -n "$scope" ]]; then systemctl --user stop "$scope" >/dev/null 2>&1 || true; fi
  rm -rf -- "$TMPDIR"
}
trap cleanup EXIT
test_command=(timeout --kill-after=15s "${EYA_BROWSER_TEST_TIMEOUT:-20m}" "$@")
if systemctl --user show-environment >/dev/null 2>&1; then
  scope="eya-browser-test-$$-${TMPDIR##*.}.scope"
  limits=(
    "--property=MemoryHigh=${EYA_BROWSER_TEST_MEMORY_HIGH:-2G}"
    "--property=MemoryMax=${EYA_BROWSER_TEST_MEMORY_MAX:-3G}"
    "--property=RuntimeMaxSec=${EYA_BROWSER_TEST_TIMEOUT:-20m}"
    --property=TimeoutStopSec=15s
    --property=MemorySwapMax=0
    --property=OOMPolicy=kill
  )
  systemd-run --user --scope --quiet --unit="$scope" "${limits[@]}" -- "${test_command[@]}"
elif [[ "${EYA_BROWSER_TEST_UNCAPPED:-}" == 1 ]]; then
  "${test_command[@]}"
else
  echo "A user systemd scope is required for browser tests on shared hosts." >&2
  echo "Use EYA_BROWSER_TEST_UNCAPPED=1 only in an already isolated environment." >&2
  exit 1
fi

#!/bin/sh
# Everything CI runs that does not need a network, in one command.
# Run this before pushing; it is the same set of gates, in the same order.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

step() { printf "\n\033[1m== %s\033[0m\n" "$1"; }

step "fixtures are deterministic"
python3 fixtures/build_fixtures.py >/dev/null
git diff --quiet -- fixtures/bin fixtures/cases fixtures/manifest.json \
  || { echo "fixtures changed; commit them or fix the generator"; exit 1; }
echo "unchanged"

step "guards"
python3 scripts/check_determinism.py --self-test
python3 scripts/check_version.py | tail -1
python3 scripts/check_packaging.py --self-test | tail -1

step "javascript parses"
for f in $(find js/src js/bin web -name '*.js' -not -path '*/dist/*' | sort); do
  node --check "$f"
done
echo "all modules parse"

step "python tests"
(cd python/tests && python3 -m unittest discover -s . 2>&1 | tail -3)

step "javascript tests"
(cd js && node --test test/*.test.js 2>&1 | grep -E '^# (tests|pass|fail)')

step "output parity"
./scripts/parity.sh | tail -1

step "web build"
node scripts/build_web.mjs | tail -1

printf "\n\033[1mall local gates passed\033[0m\n"

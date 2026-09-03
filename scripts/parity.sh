#!/bin/sh
# The parity gate: both cores over the same inputs must produce byte-identical output.
# Without this the two implementations drift within a week.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT=${TMPDIR:-/tmp}/dashgps-parity.$$
mkdir -p "$OUT/py" "$OUT/js"
trap 'rm -rf "$OUT"' EXIT

for group in day file none; do
  for extra in "" "--include-glitch" "--no-points"; do
    rm -rf "$OUT/py" "$OUT/js"
    PYTHONPATH=python/src python3 -m dashgps.cli extract fixtures/bin \
      -o "$OUT/py" --group $group --meta -q $extra || [ $? -eq 1 ]
    node js/bin/dashgps.js extract fixtures/bin \
      -o "$OUT/js" --group $group --meta -q $extra || [ $? -eq 1 ]
    if ! diff -r "$OUT/py" "$OUT/js" > "$OUT/diff.txt" 2>&1; then
      echo "PARITY FAILED (--group $group $extra)"
      head -60 "$OUT/diff.txt"
      exit 1
    fi
    echo "  ok: --group $group $extra"
  done
done

# ZIP output too: forgetting the fixed DOS timestamp would make every archive differ.
PYTHONPATH=python/src python3 -m dashgps.cli extract fixtures/bin --zip "$OUT/py.zip" -q \
  || [ $? -eq 1 ]
node js/bin/dashgps.js extract fixtures/bin --zip "$OUT/js.zip" -q || [ $? -eq 1 ]
cmp "$OUT/py.zip" "$OUT/js.zip" || { echo "PARITY FAILED (zip bytes differ)"; exit 1; }
echo "  ok: zip archives are byte-identical"

echo "PARITY OK"

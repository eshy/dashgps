#!/bin/sh
# Regenerate golden outputs from the committed fixtures using the PYTHON core, which is the
# reference implementation. The JS suite asserts against these same files. spec/40-fixtures.md
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
rm -rf fixtures/golden
mkdir -p fixtures/golden
for case_file in fixtures/cases/*.json; do
  id=$(basename "$case_file" .json)
  out=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['output'])" "$case_file")
  mkdir -p "fixtures/golden/$id"
  # Exit code 1 means "nothing in this input parsed", which is the expected outcome for the
  # negative fixtures. Only a real crash should stop the run.
  PYTHONPATH=python/src python3 -m dashgps.cli extract "fixtures/bin/$out" \
    -o "fixtures/golden/$id" --group none --meta -q || [ $? -eq 1 ]
done
echo "regenerated $(ls fixtures/golden | wc -l) golden directories"

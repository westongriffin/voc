#!/bin/bash
# Runs every tests/test_*.js under macOS JavaScriptCore with the PURE modules loaded first (SPEC §1).
# Missing PURE files are skipped with a warning so the harness is usable while modules are still being written.
# Exits non-zero when any test file fails (jsc exits non-zero on an uncaught throw).
# The loop globs tests/test_*.js, so a new file (for example tests/test_seed_agreement.js) is picked up automatically.
set -u
cd "$(dirname "$0")/.." || exit 2

JSC="${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc}"
if [ ! -x "$JSC" ]; then
  echo "ERROR: jsc not found at $JSC" >&2
  exit 2
fi

# js/charts.js is on the list because tests/test_charts_pure.js exercises its pure helpers (palette, slots, toTable,
# sparkline SVG); it touches Chart.js/the DOM only inside guarded functions, so it loads cleanly under jsc.
PURE="js/util.js js/db.js js/lexicon.js js/rules.js js/classify.js js/data.js js/store.js js/analytics.js js/predict.js js/alerts.js js/narrate.js js/charts.js js/report.js js/mime.js js/importers.js js/exporter.js js/connector.js"
FILES=()
for f in $PURE; do
  if [ -f "$f" ]; then
    FILES+=("$f")
  else
    echo "WARN: $f missing — skipped" >&2
  fi
done

pass=0
fail=0
failed=()
shopt -s nullglob
tests=(tests/test_*.js)
if [ ${#tests[@]} -eq 0 ]; then
  echo "No tests found under tests/" >&2
  exit 1
fi

for t in "${tests[@]}"; do
  echo "== $t"
  if "$JSC" tests/_jsc_shim.js "${FILES[@]}" "$t"; then
    echo "-- PASS $t"
    pass=$((pass + 1))
  else
    echo "-- FAIL $t"
    fail=$((fail + 1))
    failed+=("$t")
  fi
done

echo
echo "Test files: $pass passed, $fail failed"
if [ $fail -gt 0 ]; then
  printf 'Failed: %s\n' "${failed[@]}"
  exit 1
fi
exit 0

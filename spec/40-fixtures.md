# 40 — Fixtures and goldens

No real dashcam files can be committed: they contain the owner's home address in the coordinates,
and they are gigabytes each. Every test therefore runs against **synthetic** files generated from
the layouts in the format specs.

This is the honest limitation of the test suite: it proves the code matches the documented layout,
not that the documentation matches every real camera. The verified corpus is the acceptance test
and it lives on the owner's disk.

## Generator

`fixtures/build_fixtures.py` — stdlib only, deterministic. Pseudo-randomness comes from an inline
xorshift32 seeded per case, so output is identical on every platform and Python version. It reads
`fixtures/cases/*.json`, writes `fixtures/bin/<output>`, and rewrites `fixtures/manifest.json` with
each file's sha256 and size.

CI runs the generator and then `git diff --exit-code fixtures/bin fixtures/manifest.json`. If a
change to the generator alters a fixture, that shows up as a reviewable diff rather than a silent
drift.

## Case descriptor

```json
{
  "id": "ligo_ts_trailer_basic",
  "spec": "01-ligogps-ts-trailer",
  "builder": "ligo_ts_trailer",
  "output": "ligo_ts_trailer_basic.ts",
  "expect": { "format": "ligo.ts_trailer", "points": 296, "stride": 140 },
  "params": { "...": "builder-specific" }
}
```

`expect` is asserted directly by both suites, on top of the golden comparison, so a case states its
intent in a human-readable way.

## Goldens

`scripts/regen_golden.sh` runs the Python CLI over every fixture with a fixed option set and writes
`fixtures/golden/<case_id>/`:

| File | Contents |
|---|---|
| `points.csv` | CSV output |
| `track.gpx` | GPX output |
| `track.geojson` | GeoJSON output |
| `summary.json` | summary output |
| `meta.json` | `format_id`, `stride`, `record_count`, `variant`, `warnings`, and the **IO trace** |

The IO trace — the exact list of `readRange` calls and the total bytes read — is asserted by both
suites. That is what makes "dashgps only reads the tail of your 1 GB file" a *tested* property
rather than a claim in the README.

## Lockstep

Both suites glob `fixtures/cases/*.json` and generate one test per case, so adding a case adds
tests to both languages with no code change. Each suite additionally asserts that every case has a
golden directory and every golden directory has a case — a silently skipped test fails the run.

`scripts/parity.sh` then runs both CLIs over the whole fixture set and `diff -r`s the outputs,
catching CLI-level divergence (grouping, filenames, ordering, zip bytes) that per-case tests miss.

# Verification

Two very different kinds of evidence back this project, and it is worth being explicit about what
each one does and does not prove.

## 1. Synthetic fixtures — run on every commit

29 generated files covering every clause of every spec, plus negative cases. Both language cores
assert byte-exact equality against committed golden outputs, and the exact list of byte ranges each
parser reads.

**Proves:** the code matches the documented layout, the two implementations agree byte-for-byte,
and the read budgets hold.

**Does not prove:** that the documented layout matches any real camera. A spec written from a
misread hex dump would produce fixtures that confirm the mistake — which is not hypothetical; see
below.

## 2. The real corpus — run by hand, on hardware we own

1,230 `.ts` clips, about 1.2 TB, from an ICESKY dashcam: a Miami → Los Angeles road trip recorded
over three weeks in August 2026. This is the acceptance test for `ligo.ts_trailer`.

### Result, 2026-09-03, dashgps 0.1.0

```
files                1230
parsed               1079      (151 clips truncated by power loss carry no trailer)
groups                 20      (calendar days)
points             313303
distance          7124.5 km
outliers flagged      157      (0.05%)
duplicate stamps     1570      collapsed
elapsed            161.9 s     over ~1.2 TB of input
```

Compared point-for-point against the output of the original, independently written extraction
script:

```
unique timestamps in old: 313303
unique timestamps in new: 313303
only in old:                   0
only in new:                   0
shared with differing coords:  0
```

An exact match, and the resulting track follows the known route: Miami → Cape Canaveral →
Jacksonville → Tallahassee → New Orleans → Houston → San Antonio → El Paso → Tucson → Phoenix →
Sedona/Flagstaff → Grand Canyon → Los Angeles → Bakersfield → Monterey → Bay Area → Los Angeles.

The 157 flagged points are real receiver glitches, the largest being a burst on 2026-08-19 where
the reported position jumps roughly 100 km into the Pacific for 20 seconds before snapping back to
Monterey.

## What the real corpus caught that the fixtures could not

Both of these passed a full green test suite before the corpus run, and both were wrong.

**The stride was 132, not 140.** Our spec asserted 140 from a hand-read hex dump; the arithmetic
was wrong. Every real file uses 132 — the same value ExifTool assumes. The spec, the fixtures and
the upstream bug report were all corrected. The parser survived because it detects the stride
rather than trusting the document, which is the argument for doing so.

**Duplicate timestamps within a single clip.** The receiver sometimes emits two fixes stamped with
the same second, up to 39 times in a day. That leaves `dt = 0`, which the run logic read as a
teleport and used to flag 650 good points on Day 1 as glitches. Grouping now collapses duplicate
timestamps, and `dt <= 0` no longer condemns a run. The synthetic fixtures never produced a
duplicate timestamp, so nothing in CI could have found this.

**A performance flaw, also invisible to CI.** Clips with no trailer fell through to the full-scan
formats, so each one cost three complete passes over a ~1 GB file. Fixtures are kilobytes, so the
suite was instant either way; the corpus took minutes per day folder. Full-scan formats are now
bounded by `--scan-cap` and are off by default above 512 MB of input.

## Reproducing the corpus run

The corpus is not public — it is 1.2 TB and its coordinates are somebody's home address. For
anyone with comparable footage:

```console
$ dashgps ~/Dashcam/Trip -r -o out/ --group day --format csv,summary
$ python3 - <<'PY'
import csv, glob, json
pts = {}
for f in glob.glob('out/*.csv'):
    for r in csv.DictReader(open(f)):
        pts.setdefault(r['timestamp'], (r['lat'], r['lon']))
print(len(pts), 'unique timestamps')
PY
```

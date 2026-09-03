# dashgps

Extract GPS tracks from dashcam video files and export them as CSV, GPX or GeoJSON.

**[Try it in your browser →](https://eshy.github.io/dashgps/)** — drop in a clip or a whole
trip's folder. Nothing is uploaded; parsing happens on your machine.

```
pip install dashgps          # command line, no dependencies
npm install -g dashgps       # same thing, if you prefer Node
```

There is also a **single-file build** — `dashgps-standalone.html`, the whole tool in one 184 KB
file. Save it and it works offline, forever, with no server and no install.

```console
$ dashgps ~/Dashcam/Trip -r -o tracks/
[1/1230] 20260803_095418_F.ts  ligo.ts_trailer  157 points
...
wrote 41 files to tracks/

$ dashgps inspect 20260803_095418_F.ts
format      ligo.ts_trailer (verified)
points      157  (dropped no-fix: 143)
IO          56020 bytes read in 3 ranges (0.006% of the file)
```

That last line is the point of the tool. For the format it was built for, the GPS log is a plain-
text block appended **after** the video stream, so dashgps seeks to the end and reads a few tens of
kilobytes instead of decoding a gigabyte. A 1,230-clip, 1.2 TB trip extracts in under three
minutes, and the browser version does the same thing with `Blob.slice()`.

## Supported formats

| Format | Where it lives | Status |
|---|---|---|
| `ligo.ts_trailer` | Plain-text trailer after the last TS packet | **Verified** |
| `ligo.plain` | Same records in an MP4 `skip`/`free`/`udta` atom | Reverse-engineered |
| `viidure` | `Viidure` ASCII records on TS PID 0x0300 (INNOVV N2) | Untested |
| `nmea` | `$--RMC`/`$--GGA` in TS private streams or MP4 atoms | Untested |

`dashgps formats` prints this table with the IO cost of each.

**The status column is not decoration.**

- **Verified** — run against real files from that camera, in quantity. `ligo.ts_trailer` was
  reverse-engineered from and validated on ~1,230 clips (1.2 TB) from an **ICESKY** dashcam; the
  extraction reproduces all 313,303 points of a known Miami → Los Angeles trip exactly. Cameras
  using the "HIT GPS Player" or Viidure desktop apps are likely the same family.
- **Reverse-engineered** — derived from a real artifact, but not confirmed end to end.
- **Untested** — built from a published sample or a public standard. **No file from such a camera
  has ever been run through it.** If you own one, please
  [send a diagnostic](https://github.com/eshy/dashgps/issues/new?template=new-format.yml) —
  `dashgps inspect --redact` produces a redacted report that is usually all we need.

For anything else, the CLI can hand the file to your own ExifTool install:

```console
$ dashgps ~/clips --exiftool -o tracks/
```

## How is this different from ExifTool?

[ExifTool](https://exiftool.org/) reads 124 kinds of timed GPS metadata and is the reference work
in this space. dashgps reads four. It is not a replacement, and where they overlap you should
probably use ExifTool.

dashgps exists for two things ExifTool does not do:

1. **A browser tool you can link to.** No install, no command line, and the video never leaves the
   machine — for the trailer format only the last few kilobytes of each file are ever read.
2. **A format ExifTool currently misses.** Its `LigoGPS` module handles this family, but its
   MPEG-TS trailer probe requires the file to end with `&&&&` + length, and these cameras write
   `####`. Everything after that point — the block layout, the `LIGOGPSINFO + 0x14` record offset,
   the 132-byte stride — matches what ExifTool already assumes. See
   [`docs/exiftool-report.md`](docs/exiftool-report.md); we intend to report it upstream.

No ExifTool code is vendored, linked, or was consulted while writing any parser here. See
[`NOTICE.md`](NOTICE.md).

## Output

`--format csv,gpx,geojson,summary`, grouped with `--group day|file|none`.

**CSV** columns:

```
day,timestamp,lat,lon,speed_kmh,heading_deg,altitude_m,magvar_deg,
accel_x,accel_y,accel_z,dt_s,outlier,source_file
```

Two columns are worth knowing about:

- **`dt_s`** — seconds since the previous point. Anything above ~5 is a recording gap; break your
  polyline there rather than drawing a straight line across it. GPX and GeoJSON already do this
  for you, one `<trkseg>` / `LineString` per continuous run.
- **`outlier`** — `1` marks a point in a run dashgps believes is a GPS glitch. Points are flagged,
  never deleted. On the verified corpus this is 157 points out of 313,303 — bursts where the
  receiver reports a stale position, in one case 100 km out into the Pacific for 20 seconds.

**Timestamps are the camera's own clock and carry no timezone.** dashgps never guesses one:
`time_is_naive` rides in the summary, and `--tz-offset -07:00` converts to real UTC. When a file
contains both a naive format and NMEA (which is UTC by definition), `dashgps inspect` reports the
implied offset.

## Documentation

- [`spec/`](spec/) — a byte-level document per format, written before the parser. The parsers cite
  its clause numbers; each spec's Conformance table names the fixtures covering each clause.
- [`spec/30-formatting.md`](spec/30-formatting.md) — why there are two implementations and how
  they are kept byte-identical.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, the add-a-format checklist, how to send a
  sample safely.

## Two implementations, one output

The Python and JavaScript cores are file-for-file mirrors, and CI diffs their output over the whole
fixture set — including the bytes of the ZIP archive. Neither is allowed to use a built-in number,
date or JSON formatter, because those differ between the languages;
`scripts/check_determinism.py` fails the build on the pull request that introduces one, and
self-tests that it can still catch violations.

Every test runs against **synthetic** fixtures generated from the specs, because real dashcam files
are gigabytes each and their coordinates are somebody's home address. That proves the code matches
the documented layout, not that the documentation matches every camera — which is exactly why the
status column above exists, and why we want your diagnostics.

```console
$ python3 fixtures/build_fixtures.py && git diff --exit-code fixtures/   # deterministic
$ cd python/tests && python -m unittest discover -s .                    # 109 tests
$ cd js && node --test                                                   # 106 tests
$ ./scripts/parity.sh                                                    # byte-for-byte
```

## Releasing

[`docs/releasing.md`](docs/releasing.md). Publishing goes through a tagged release that runs the
full gate first, using PyPI Trusted Publishing so no long-lived token exists.

## Licence

MIT. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md) for how each format was derived.

# Changelog

## 0.1.0 — unreleased

First release.

### Formats

- `ligo.ts_trailer` (**verified**) — plain-text LigoGPS trailer appended after the last MPEG-TS
  packet. Reverse-engineered from and validated against ~1,230 real ICESKY clips (1.2 TB);
  reproduces all 313,303 points of a known trip exactly. Accepts both the `####` end magic these
  cameras write and the `&&&&` variant ExifTool documents, both `SKIP` and `skip` block tags, block
  sizes that do and do not count their header, and an autodetected record stride.
- `ligo.plain` (reverse-engineered) — the same records in an MP4 `skip`/`free`/`udta` atom or a
  bare TS stream.
- `viidure` (untested) — `Viidure` ASCII records on TS PID 0x0300.
- `nmea` (untested) — NMEA 0183 in TS private streams and MP4 atoms.

### Tools

- Python CLI (`extract`, `formats`, `inspect`), zero dependencies, Python 3.9+.
- Node CLI with identical output, published as an npm package.
- Browser app: worker pool, folder drag-and-drop, self-contained canvas map with optional OSM
  tiles, CSV/GPX/GeoJSON/ZIP export. Nothing is uploaded.

### Guarantees

- Byte-identical output from both cores, enforced by a CI parity gate including ZIP bytes.
- Read budgets are asserted, not claimed: the golden tests pin the exact byte ranges each parser
  reads, so "only reads the tail of your 1 GB file" is a test failure if it regresses.
- Full-scan formats are bounded by `--scan-cap` and are off by default for large inputs, so one
  unrecognised clip in a folder cannot trigger a pass over every gigabyte.

# 00 — Data model

## Point

The single record type every parser produces. Fields absent from a source format are NaN.

| Field | Type | Units | Notes |
|---|---|---|---|
| `t` | float | seconds since Unix epoch | naive camera-local unless the format is UTC-defined (NMEA) |
| `lat`, `lon` | float | decimal degrees, WGS-84 | signed; south and west negative |
| `speed_kmh` | float | km/h | normalised at parse time from the source unit |
| `heading_deg` | float | degrees true, 0–360 | course over ground |
| `alt_m` | float | metres | |
| `magvar_deg` | float | degrees | magnetic variation |
| `ax`, `ay`, `az` | float | g | accelerometer |
| `idx` | int | | record index within the source file, `-1` if the format has none |
| `src` | int | | index into `ParseResult.sources` |

Post-processing adds `dt_s` (float, seconds since the previous point in the same output group),
`run` (int, run index) and `outlier` (0 or 1).

## ParseResult

```
points   : list[Point]
format_id: str          e.g. "ligo.ts_trailer"
status   : str          "verified" | "reverse-engineered" | "untested"
sources  : list[str]    source file names, byte-sorted
meta     : dict         format-specific: stride, record_count, variant, block offsets, magic
warnings : list[str]    ordered, deduplicated by first occurrence
dropped_nofix : int
```

`meta` and `warnings` are part of the golden output, so any change in parser behaviour shows up as
a reviewable diff.

## Reader

The IO abstraction every parser sees. Implementations: `FileReader` (Python), `NodeFileReader`
and `BlobReader` (JS), `BytesReader` (both, for tests), and `CountingReader` which wraps any of
them and records every range read.

```
size() -> int
read_range(start, end) -> bytes        # [start, end), clamped to [0, size)
```

JavaScript's `readRange` is async and its parsers are `async`; that is the only structural
difference between the two cores.

`Slab` is a fetched buffer plus its absolute base offset, so parsers index in absolute file
coordinates and never accidentally re-fetch: `u8`, `u16be`, `u32be`, `bytes`, `find`, `rfind`,
`covers`.

## Format registry

```
FormatSpec: id, name, status, cost, extensions, sniff(reader, opts) -> float, parse(reader, opts)
```

`cost` is `"tail"`, `"head"` or `"full-scan"` and declares the format's IO appetite. `parse_auto`:

1. Sniff all `tail` formats. Best score >= 0.9 wins.
2. Else sniff all `head` formats. Best score >= 0.9 wins.
3. Else, only if `opts.deep`, sniff `full-scan` formats; best score >= 0.5 wins.
4. Else raise `NoFormatMatch`, carrying every sniff score so `inspect` can show them.

Within a tier, formats are sniffed in registration order and the first to score >= 0.9 wins
immediately — so a confident cheap hit never pays for a later format's expensive scan. If nothing
in the tier is confident, the best score wins, with ties broken by `(score, cost rank,
registration order)`. Registration order is fixed in `formats/__init__` and is part of this spec,
because parity depends on it.

Sniff budgets are enforced by tests: a `tail` sniff may read at most the last 64 KiB, a `head`
sniff at most the first 256 KiB, and a `full-scan` format may read at most `scan_cap` bytes
(default 64 MiB) from each end of the file.

64 KiB for a tail sniff is chosen so that one read usually brings back the entire metadata block,
letting sniff and parse share a single seek. On a network filesystem the round trips, not the
bytes, are what cost: three small reads per file turned a 1,230-clip folder from seconds into
minutes. It is still 0.006 % of a 1 GB clip.

Because `parse_auto` resets `opts.probe` on entry, a format may memoize a probe there and have it
survive from its `sniff` into its `parse` without re-reading.

# 01 — LigoGPS TS trailer  (`ligo.ts_trailer`)

**Status: VERIFIED.** Derived by reverse-engineering and confirmed against 1,230 real files
(~1.2 TB) from an ICESKY dashcam, cross-checked against the vendor's own "HIT GPS Player".
313,303 points extracted; the resulting track matches a known Miami → Los Angeles road trip.

## Provenance

Reverse-engineered from files we own, by inspecting the byte stream directly. No GPL or
Artistic-licensed source was consulted while deriving or implementing this parser. The vendor
player (`gpsplayer.exe`, `sunningsoftGps.dll`) was examined only for printf-style format strings
visible in its `.rdata`, which confirmed the field grammar we had already recovered from data.

Related work, for the reader's orientation only: ExifTool has a `LigoGPS` module that handles
several members of this family. It does not read the files this spec describes — see
[§1.9](#19-relationship-to-exiftool).

## 1.1 Where the data lives

The file is a normal MPEG-TS stream. After the last 188-byte transport packet, a metadata
**trailer** is appended. The video decodes fine without it; most tools never look.

```
┌──────────────────── file ────────────────────┐
│ 188-byte TS packets … (video, audio, private)│
├──────────────────────────────────────────────┤
│ trailer:  block₀ block₁ … blockₙ  END-MAGIC  │
└──────────────────────────────────────────────┘
```

The file length is generally **not** a multiple of 188; the remainder is the trailer.

Because the payload is at the end, a parser reads the last few kilobytes and nothing else. On the
verified corpus this is ~50 KB per ~1 GB clip.

## 1.2 End magic (last 8 bytes)

```
offset      size  meaning
size-8      4     '####'  (0x23232323)  or  '&&&&' (0x26262626)
size-4      4     uint32 BE — total trailer length in bytes, counting these 8
```

The verified ICESKY corpus uses `####`. ExifTool's samples of the same family use `&&&&`. Both are
accepted. The trailer region is `[size - length, size)`.

## 1.3 Block framing

Blocks run from the start of the trailer region. Each has an 8-byte header:

```
offset      size  meaning
+0          4     uint32 BE — block size
+4          4     tag: 'SKIP' or 'skip'   (case varies by firmware)
+8          …     payload — begins immediately with the ASCII 'LIGOGPSINFO'
```

Whether the block size counts the 8-byte header is **not consistent across firmware**. Clause 3 of
the parse algorithm resolves this by trying both and validating the landing site.

A file may contain several blocks. In the verified corpus there are two: a binary block of
`####`-prefixed fixed records (contents not decoded — believed to be per-frame indices), then the
ASCII GPS block. Some files also carry a `****` marker with two uint32 BE lengths between blocks.
Blocks that are not ASCII GPS are skipped.

## 1.4 GPS block header

Relative to the first byte of `LIGOGPSINFO`:

```
+0x00   11   'LIGOGPSINFO'
+0x0B    1   variant byte              (0x09 observed in the ICESKY corpus)
+0x0C    2   unknown                   (0x20 0x20 observed)
+0x0E    2   zero
+0x10    4   uint32 BE — record count  (300 = one per second of a 5-minute clip)
+0x14   …    first record
```

Records begin at `LIGOGPSINFO + 0x14`.

## 1.5 Record layout

```
+0x00    4   uint32 BE — 1-based record index
+0x04    …   NUL-padded ASCII, up to (stride - 4) bytes
```

**The stride is not asserted.** Every one of the ~1,230 verified files uses **132** bytes, which
is also what ExifTool assumes for this family. We nevertheless detect it rather than hard-code it:
the block header carries a record count and a variant byte that clearly vary by firmware, and a
hard-coded stride is exactly the assumption that makes a parser silently desynchronise on the next
camera. Clause 6 detects it and refuses rather than guessing.

The ASCII payload, single-space separated:

```
2026/08/03 09:59:18 N:25.774430 W:080.137840 0.0 km/h x:0.00 y:0.00 z:0.00 A:259.0 H:-8.0 M:0.0
└── date ──┘└─ time ─┘└─ lat ──┘ └─── lon ───┘ └ speed ┘ └── accelerometer ──┘ └─A─┘ └─H──┘ └M─┘
```

| Token | Field | Units |
|---|---|---|
| 0 | date `YYYY/MM/DD` | camera-local, no zone |
| 1 | time `HH:MM:SS` | camera-local, no zone |
| 2 | `N:` / `S:` + latitude | decimal degrees, sign from the letter |
| 3 | `E:` / `W:` + longitude | decimal degrees, sign from the letter |
| 4, 5 | speed, literal `km/h` | km/h |
| 6, 7, 8 | `x:` `y:` `z:` | accelerometer, g |
| 9 | `A:` | heading / course over ground, degrees true |
| 10 | `H:` | altitude, metres |
| 11 | `M:` | magnetic variation, degrees |

`A`, `H` and `M` are optional; older firmware stops after the accelerometer. Absent fields are NaN.

**`M:` is magnetic variation, not mileage.** It reads 0.0 on every record in the verified corpus,
which is consistent with a receiver that does not compute it. An earlier draft of our own notes
called it mileage; that was wrong.

### No-fix records

Before the receiver acquires a fix, records are written as:

```
2026/08/03 09:54:19 N:0 E:0 0 km/h x:0.0 y:0.0 z:0.0 A:0 H:0 M:0
```

These are dropped, not emitted at (0, 0). The count is reported as `dropped_nofix`. On the verified
corpus this is 8,794 records — mostly the first ~30 s after each ignition-on, plus whole clips
recorded in parking garages.

## 1.6 Parse algorithm

Implementations cite these clause numbers in comments.

1. **Footer.** Read the last `min(size, 65536)` bytes — one read that usually brings back
   the whole trailer, so sniff and parse share a single seek. Require the 4 bytes at `size-8` to be `####`
   or `&&&&`. Read `L = uint32BE(size-4)`. Reject `L < 8` or `L > size`.
2. **Trailer region.** `[size - L, size)`. Read `[max(size-L, size-tail_cap), size)` where
   `tail_cap` defaults to 1 MiB. If `L > tail_cap`, warn and parse only the covered part.
3. **Block walk.** From the trailer start, read `sz = uint32BE`, `tag = bytes[4:8]`. Require
   `tag ∈ {'SKIP','skip'}`. Advance by `sz` if that lands on another valid header or exactly on the
   trailer end; otherwise advance by `sz + 8` under the same test; otherwise **resync** by
   searching forward for the next `SKIP`/`skip` whose preceding 4 bytes form a plausible size.
   Every resync appends a warning. Warnings are part of the golden output, so resync behaviour is
   pinned by tests.
4. **Block filter.** Require `LIGOGPSINFO` immediately after the tag. Read the variant byte and the
   uint32 BE record count. Records start at `+0x14`.
5. **ASCII test.** Keep the **last** block whose first record region is ASCII: every byte in
   `0x20..0x7E` or `0x00`, and the 11 bytes at `first_rec+4` match `DDDD/DD/DD ` where `D` is a
   digit.
6. **Stride autodetect.** Scan `[first_rec+4, first_rec+4+2048)` for the second occurrence of the
   `DDDD/DD/DD ` shape at a 4-byte-aligned position. `stride = off₂ - off₁`. Accept only if:
   - `100 <= stride <= 1024`, and
   - `stride % 4 == 0`, and
   - a third record validates at `off₁ + 2*stride` when the block is long enough.

   On failure, try `[132, 140]` in order and accept the first that validates two consecutive
   records. If none validates, **raise** — a wrong stride yields plausible-looking garbage, which
   is worse than an error.
7. **Record count.** `n = min(count_field, (block_end - first_rec) // stride)`. If `count_field` is
   0 or disagrees with the derived value by more than 1, use the derived value and warn.
8. **Records.** For each `i in [0, n)`: index = `uint32BE(first_rec + i*stride)`, ASCII =
   bytes from `+4` to the first NUL. Tokenize on single spaces by fixed position (no regex).
   Drop no-fix records per §1.5.

## 1.7 Numeric parsing

Each numeric token is validated character-by-character against `[-+]?[0-9]*\.?[0-9]*` (at least one
digit required) and then converted by the language's decimal→double conversion. Both Python's
`float()` and JavaScript's `Number()` are correctly rounded, so they produce bit-identical doubles.
A token failing validation makes the field NaN and appends a warning; it does not abort the record.

## 1.8 Known variance

| Aspect | Observed values | Handling |
|---|---|---|
| End magic | `####`, `&&&&` | both accepted (clause 2) |
| Block tag case | `SKIP`, `skip` | both accepted (clause 3) |
| Block size includes header | yes and no | probed (clause 3) |
| Record stride | 132 in all verified files | autodetected (clause 6) |
| Variant byte `+0x0B` | 0x09 (ICESKY); 0x01, 0x05, 0x0D, 0x14 reported elsewhere | recorded in meta, not acted on |
| Trailing `A:`/`H:`/`M:` | present or absent | optional |

The variant byte is recorded in `meta.variant` but does not currently steer parsing. In related
formats it selects a coordinate obfuscation; **no obfuscation is present in any verified file**, and
dashgps does not implement one. If a submitted sample shows coordinates that are self-consistent
but geographically wrong, that is the signal it is obfuscated, and it needs its own spec.

## 1.9 Relationship to ExifTool

ExifTool's `LigoGPS.pm` handles this family but does not read the verified corpus. One concrete
reason, worth reporting upstream:

1. Its M2TS trailer probe requires the final 8 bytes to be `&&&&` + length. ICESKY writes `####`,
   so the trailer is never found and no GPS is extracted.
That is the only difference. Records start at `LIGOGPSINFO + 0x14` and the stride is 132, exactly
as ExifTool assumes, and its plaintext-record branch parses our ASCII correctly. **Accepting
`####` alongside `&&&&` in its M2TS trailer probe would be enough to make it read these files.**

An earlier draft of this document claimed the stride was 140 and that ExifTool would desynchronise.
That was our own arithmetic error while reading a hex dump, caught by running the parser against
the real corpus. It is recorded here because it is the kind of mistake a reader of this spec should
know we are capable of making.

`docs/exiftool-report.md` holds a ready-to-file write-up.

## 1.10 Conformance

Fixture cases covering this spec:

| Case | Clauses |
|---|---|
| `ligo_ts_trailer_basic` | 1–8, stride 132 (as in every real file) |
| `ligo_ts_trailer_amp_magic` | 2 (`&&&&`) |
| `ligo_ts_trailer_stride140` | 6 (a stride never seen in the wild, proving autodetect) |
| `ligo_ts_trailer_multiblock` | 3, 5 (binary block first, ASCII block last) |
| `ligo_ts_trailer_size_excl_header` | 3 (size excludes header → probe) |
| `ligo_ts_trailer_resync` | 3 (corrupt size → resync + warning) |
| `ligo_ts_trailer_count_zero` | 7 (count field 0 → derived) |
| `ligo_ts_trailer_count_high` | 7 (count field too large → clamped + warning) |
| `ligo_ts_trailer_all_nofix` | 1.5 (0 points, no error) |
| `ligo_ts_trailer_no_ahm` | 1.5 (optional trailing fields absent) |
| `ligo_ts_trailer_large` | 2 (tail-only IO trace on a multi-MB file) |
| `ligo_ts_trailer_bad_length` | 1 (length > file size → error) |

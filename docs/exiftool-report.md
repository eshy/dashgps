# Report for ExifTool: LigoGPS trailers ending `####` are not found

Filed upstream as <https://github.com/exiftool/exiftool/issues/470> on 2026-09-03.
The section at the end records the confirmation run made after filing.

---

**Title:** `-ee3` finds no GPS in `.ts` files whose LigoGPS trailer ends with `####` instead of `&&&&`

### Summary

`M2TS.pm` looks for a LigoGPS trailer by checking that the final 8 bytes of the file are
`&&&&` followed by a big-endian uint32 length. Some cameras write **`####`** there instead. On
those files the trailer is never located and `-ee3` reports no GPS, even though the block itself is
in the layout `LigoGPS.pm` already understands.

Accepting `####` alongside `&&&&` appears to be sufficient.

### Evidence

~1,230 `.ts` files (about 1.2 TB) from an ICESKY dashcam, sold with a Windows player branded
"HIT GPS Player" (`gpsplayer.exe`, `sunningsoftGps.dll` — the Sunningsoft/Viidure lineage that
`M2TS.pm` already references for the `Viidure` record variant).

Last 16 bytes of a representative file:

```
00 00 00 00 00 00 00 00 23 23 23 23 00 00 9a d4
                        #  #  #  #  |--length--|
```

`0x00009ad4` = 39,636 bytes, which is exactly the trailer:

```
    8  block header:  uint32BE size + 'SKIP'
   20  'LIGOGPSINFO' + variant byte 0x09 + 0x20 0x20 + 0x00000000 + uint32BE count (300)
39600  300 records x 132 bytes
    8  '####' + uint32BE 39636
-----
39636
```

Everything after the end magic matches what `LigoGPS.pm` already assumes:

- the block tag is `SKIP` — matched by the existing case-insensitive `/skip$/i` test;
- records begin at `LIGOGPSINFO + 0x14`;
- the stride is **0x84 (132)**, the hard-coded value in `ProcessLigoGPS`;
- records are the unencrypted plaintext dialect (`uint32` counter + `YYYY/MM/DD HH:MM:SS N:… W:…
  … km/h x:… y:… z:… A:… H:… M:…`), which `ParseLigoGPS` reads correctly with flags `0x03`;
- coordinates are **not** fuzzed — decoded values place the track exactly where the trip went.

A decoded record, for reference:

```
2026/08/03 09:59:18 N:25.774430 W:080.137840 0.0 km/h x:0.00 y:0.00 z:0.00 A:259.0 H:-8.0 M:0.0
```

### Suggested change

In `M2TS.pm`, where the trailer is probed:

```perl
    $buff =~ /^&&&&/
```

becomes something like

```perl
    $buff =~ /^(&&&&|####)/
```

with the length still read as `unpack('x4N', $buff)`.

We have not sent a patch because we would rather not muddy provenance in either direction — our own
implementation is MIT licensed and written without reference to ExifTool source. The finding is
offered as data.

### Notes

- Variant byte at `LIGOGPSINFO + 0x0B` is `0x09` on every file we have. `LigoGPS.pm` has seen
  `0x01`, `0x05`, `0x0D` and `0x14`. Since `0x09` is not in the `[\x01\x14]` "not fuzzed" set, a
  naive read would fuzz these coordinates — but the records here are the plaintext dialect, which
  `ProcessLigoGPS` already routes to `ParseLigoGPS` with `notFuzzed|kmh` before the fuzz flag
  matters. **Now confirmed empirically — see below. No fuzzing occurs.**
- `count_field` at `+0x10` is 300 on essentially every clip (one per second of a five-minute
  recording) and 299 on a few. `ProcessLigoGPS` ignores it and derives the count from the block
  length, which is the more robust choice; we mention it only because it is a usable cross-check.
- About 12% of the corpus are clips truncated by power loss. They have no trailer at all and no
  recoverable GPS — that is the camera's behaviour, not a parser problem.

### A correction to our own earlier note

An earlier draft of our spec claimed the stride in these files was 140 and that ExifTool would
therefore desynchronise. That was our arithmetic error reading a hex dump, caught when we ran our
parser against the full corpus. The stride is 132, exactly as ExifTool assumes. **The end magic is
the only difference.**

---

## Confirmation, run after filing

The report above was written from reading the format and the module. It has since been tested
against ExifTool **13.59**, cloned from `github.com/exiftool/exiftool` and run unmodified.

### The claim about the probe is exact

`&&&&` occurs exactly once in the entire ExifTool source tree, at `M2TS.pm:1016-1018`:

```perl
    if ($et->Options('ExtractEmbedded') and
        $raf->Seek(-8, 2) and $raf->Read($buff, 8) == 8 and
        $buff =~ /^&&&&/)
```

`LigoGPS.pm:293` sets `$pos = DirStart + 0x14`, and `LigoGPS.pm:301` iterates `$pos += 0x84`.
Both match the report. The suggested one-line change is at the right place.

### A four-byte experiment on real camera data

From a real 933 MB ICESKY clip, two files were built: the first two megabytes of the original
(genuine transport-stream packets) followed by the original 39,636-byte trailer, and a second file
identical to it except that the trailer's end magic was changed from `####` to `&&&&`. `cmp -l`
reports **4 differing bytes** and nothing else.

Run through unmodified ExifTool 13.59 with `-ee3 -api LargeFileSupport=1`:

| File | End magic | GPS tags |
|---|---|---|
| `real_hash.ts` | `####` | **0** |
| `real_amp.ts`  | `&&&&` | **1801** |

### The output is not merely present, it is correct

All 300 records decode. Comparing them against this project's own extraction of the same clip:

```
exiftool records parsed:                    300
dashgps points (no-fix already dropped):    268
timestamps not found in exiftool output:      0
coordinates identical:                      268
coordinates differing:                        0
largest difference:                         0.0 degrees
exiftool records at 0,0 (no fix):            32     (268 + 32 = 300)
```

Two independent implementations agree to the last decimal place on every fixed record, and account
for all 300. This answers the open question in the Notes: the `0x09` variant byte does **not** send
these records down the fuzzing path, and no change beyond the end magic is required.

### A minimal reproducer that carries no personal data

`fixtures/bin/ligo_ts_trailer_basic.ts` and `fixtures/bin/ligo_ts_trailer_amp_magic.ts` are
synthetic, a few kilobytes each, MIT licensed, and contain invented coordinates. They differ only
in the end magic. Unmodified ExifTool reads the `&&&&` one and finds nothing in the other:

```
ligo_ts_trailer_amp_magic.ts  ->  [LIGO] GPSDateTime, GPSLatitude, GPSLongitude, GPSSpeed,
                                  GPSTrack, GPSAltitude, MagneticVariation, Accelerometer
ligo_ts_trailer_basic.ts      ->  nothing
```

That ExifTool parses the sibling file correctly is itself the argument for the fixture's fidelity:
the layout is not our interpretation of the format, it is ExifTool's.

### One incidental confirmation

ExifTool labels the `M:` field **MagneticVariation**. An earlier version of `GPSData/README.md` in
the sibling project called it mileage. ExifTool is right; that has been corrected.

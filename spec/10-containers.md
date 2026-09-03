# 10 — Container walking

## 10.1 MPEG-TS

Packet stride is detected by testing for `0x47` at 188-, 192- and 204-byte spacing over the first
64 KiB, requiring at least 20 consecutive hits. 188 wins ties. The sync offset is the first
position that satisfies the test.

Packet header:

```
byte 0        0x47 sync
byte 1        bit 7 transport_error, bit 6 payload_unit_start_indicator (PUSI),
              bit 5 priority, bits 4-0 PID high
byte 2        PID low
byte 3        bits 7-6 scrambling, bit 5 adaptation_field, bit 4 payload, bits 3-0 continuity
```

If the adaptation-field bit is set, payload starts at `4 + 1 + payload[4]`; otherwise at 4.

### PES assembly

Dashcam GPS streams routinely omit the GPS program from the PMT, so dashgps **does not gate on the
PMT**. It scans the PIDs a format declares plus the well-known set `{0x0300, 0x0102, 0x01e4}`.

A PES packet is assembled by starting a buffer on a PUSI packet and appending payloads until the
next PUSI on the same PID. Some cameras never set PUSI at all; when a format declares
`tolerate_no_pusi`, payloads accumulate regardless, capped at 64 KiB.

Header stripping, when the payload starts with `00 00 01 <stream_id>`:

```
stream_id in {0xBC,0xBE,0xBF,0xF0,0xF1,0xF2,0xF8,0xFF} -> payload starts at +6
otherwise -> payload starts at 6 + 3 + header_data_length, where header_data_length is byte +8
```

## 10.2 ISO-BMFF (MP4/MOV)

A lazy atom walker: read the 8-byte header (`uint32 BE size`, 4-byte type), handling `size == 1`
(64-bit size in the next 8 bytes) and `size == 0` (extends to end of file). Recurses into
`moov`, `udta`, `trak`, `mdia`, `minf`, `stbl`. Never reads an atom's payload unless a format asks
for it, so walking a 1 GB file costs a few dozen small reads.

Formats in v1 look at top-level and `moov`-level `free`, `skip`, `udta` and `gps ` atoms.

## 10.3 Chunk scanning

For `full-scan` formats, `scan_chunks(reader, chunk, overlap)` yields overlapping slabs. Overlap
is mandatory — NMEA sentences and Viidure records straddle chunk boundaries — and defaults to
4 KiB with a 4 MiB chunk. Both are settable so fixtures can force tiny chunks and exercise the
boundary path on small files. A match starting inside the overlap region of the previous slab is
suppressed to avoid duplicates.

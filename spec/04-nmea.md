# 04 — NMEA 0183  (`nmea`)

**Status: untested against a real dashcam**, but the wire format is a public standard and the
parser is exercised by synthetic fixtures. This is the catch-all that gives dashgps a chance on
cameras nobody has documented.

Searched in TS private-stream PES payloads and in MP4 `free` / `skip` / `udta` atom payloads.
`--raw-nmea` additionally scans raw bytes.

## Sentences

`$--RMC` and `$--GGA` for any talker ID (`GP`, `GN`, `GL`, `GA`, `BD`). A candidate runs from `$`
to the next `$`, NUL, CR or LF. If a `*hh` checksum is present it is verified as the XOR of every
byte between `$` and `*`; mismatches are rejected and counted in `meta.checksum_rejects`.

**RMC** — `time, status, lat, N/S, lon, E/W, speed_knots, track, date, magvar, magvar_E/W`

- Coordinates are `DDMM.mmmm` / `DDDMM.mmmm`: `deg = trunc(v/100) + (v - trunc(v/100)*100)/60`.
- Speed converts knots → km/h by `× 1.852`.
- Two-digit year pivots at 70: `>= 70` is `19xx`, else `20xx`.
- `status != 'A'` means void — the fix is dropped.

**GGA** — supplies altitude and fix quality but carries no date.

## Pairing

Keep one pending fix. When a sentence's *time field* differs from the pending fix's time, flush.
Pairing on the time field rather than on line order is what makes interleaved and duplicated
streams work.

Flush emits a point only if a valid RMC is present; GGA contributes altitude. A stream with GGA
but no RMC yields no points and a warning, because there is no date.

**NMEA time is UTC by definition**, so points from this format set `time_is_naive = false`. When a
file yields both LigoGPS and NMEA points, `dashgps inspect` reports the implied camera-clock offset
— the only reliable way to recover the timezone of a LigoGPS track.

Fixture cases: `nmea_rmc_gga`, `nmea_rmc_only`, `nmea_bad_checksum`, `nmea_split_chunks`,
`nmea_gga_only`, `nmea_mp4_free`.

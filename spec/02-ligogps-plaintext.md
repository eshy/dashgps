# 02 — LigoGPS plaintext records  (`ligo.plain`)

**Status: reverse-engineered.** Same record grammar as `01-ligogps-ts-trailer.md` §1.5, found
without the trailer wrapper. No verified sample; the record grammar itself is verified.

Two placements are searched:

- **MP4** — inside a top-level or `moov`-level `skip`, `free` or `udta` atom whose payload begins
  with `LIGOGPSINFO`. Cost `head`, because the atom walk is cheap.
- **Bare TS or raw** — a `LIGOGPSINFO` header anywhere in the file, no trailer footer. Cost
  `full-scan`.

Once located, parsing is identical to `01` clauses 4–8: header at `+0x0B` / `+0x10`, records at
`+0x14`, stride autodetected.

If no `LIGOGPSINFO` header is present but the ASCII record grammar is, records are read
sequentially delimited by NUL runs rather than by a fixed stride (`stride = 0` mode), and the
uint32 index prefix is assumed absent.

Fixture cases: `ligo_plain_mp4_free`, `ligo_plain_mp4_udta`, `ligo_plain_ts_stream`.

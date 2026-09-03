# 21 — Output formats

All output obeys `30-formatting.md`. UTF-8, no BOM, `\n` line endings, exactly one trailing `\n`.

## CSV

Column order is fixed. This schema is **backward-compatible** with the CSVs the prototype produced,
so downstream work keeps running; `magvar_deg` is the one added column.

```
day,timestamp,lat,lon,speed_kmh,heading_deg,altitude_m,magvar_deg,accel_x,accel_y,accel_z,dt_s,outlier,source_file
```

- `day` is the group label (a date for `--group day`, the file stem for `--group file`, `all` for
  `--group none`).
- `timestamp` is `iso_local` — no `Z`, because the value is naive. See `30-formatting.md` §30.2.
- `dt_s` is empty on the first point of each run.
- `outlier` is `0` or `1`.
- Quoting is minimal RFC 4180: quote only when the value contains `,`, `"`, `\n` or `\r`; escape
  `"` by doubling.

## GPX 1.1

One `<trk>` per group, one `<trkseg>` per non-glitch run — so a consumer that draws segments gets
the gaps right for free. Glitch runs are emitted only with `--include-glitch`, as a separate
`<trk>` suffixed ` (glitch)`.

Fixed attribute order, 2-space indent, `creator="dashgps <VERSION>"`. The extension namespace is
`urn:dashgps:gpx:1` — a URN rather than a URL, because an XML namespace is an identifier that is
never fetched, and consumers may key on it indefinitely. Tying it to a repository URL would churn
the day the project moves owner. `<time>` is `iso_z`; an XML
comment records that the value is naive camera time when it is. Speed, heading and the
accelerometer ride in a `<extensions>` block under the `dashgps` namespace.

## GeoJSON

A `FeatureCollection`: one `LineString` Feature per non-glitch run, plus — unless `--no-points` —
one `Point` Feature per fix carrying the full property set. Coordinates are
`[lon, lat, alt]` per RFC 7946, with altitude omitted when NaN. Key order is fixed by the writer.

## Summary JSON

One entry per input file plus a `totals` object:

```
name, size, format, status, records, points, dropped_nofix, runs, glitch_runs,
t_start, t_end, bbox [w,s,e,n], distance_km, duration_s, time_is_naive, warnings, error
```

Files are ordered by `byte_key(name)`. A file that failed to parse appears with `error` set and
null metrics — a batch never silently drops a file.

## ZIP

Used by the browser for multi-file download and by `--zip`. Stored (no compression), fixed DOS
timestamp `1980-01-01 00:00:00`, CRC-32 over each member, no ZIP64 — an archive above 4 GiB is an
error rather than a corrupt file. Byte-reproducible, and diffed by the parity gate.

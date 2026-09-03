# dashgps

Extract GPS tracks from dashcam video files and export them as CSV, GPX or GeoJSON.
No dependencies, Python 3.9+.

```console
$ pip install dashgps
$ dashgps ~/Dashcam/Trip -r -o tracks/
$ dashgps inspect 20260803_095418_F.ts
format      ligo.ts_trailer (verified)
points      157  (dropped no-fix: 143)
IO          65536 bytes read in 1 ranges (0.007% of the file)
```

That last line is the point. For the format this was built for, the GPS log is a plain-text block
appended **after** the video stream, so dashgps seeks to the end and reads 64 KB instead of
decoding a gigabyte. A 1,230-clip, 1.2 TB trip extracts in under three minutes.

There is also a [browser version](https://dashgps.github.io/dashgps/) that does the same thing
client-side — your video never leaves your machine.

## Supported formats

| Format | Where it lives | Status |
|---|---|---|
| `ligo.ts_trailer` | Plain-text trailer after the last MPEG-TS packet | **Verified** |
| `ligo.plain` | The same records in an MP4 `skip`/`free`/`udta` atom | Reverse-engineered |
| `viidure` | `Viidure` ASCII records on TS PID 0x0300 (INNOVV N2) | Untested |
| `nmea` | `$--RMC`/`$--GGA` in TS private streams or MP4 atoms | Untested |

**Verified** means run against real files from that camera, in quantity: `ligo.ts_trailer` was
reverse-engineered from and validated on ~1,230 clips (1.2 TB) from an **ICESKY** dashcam, and
reproduces all 313,303 points of a known trip exactly. **Untested** means built from a published
sample or a public standard, having never seen a file from that camera — if you own one, please
[send a redacted diagnostic](https://github.com/dashgps/dashgps/issues/new?template=new-format.yml).

For anything else, hand the file to your own ExifTool install:

```console
$ dashgps ~/clips --exiftool -o tracks/
```

dashgps does not replace [ExifTool](https://exiftool.org/), which reads 124 kinds of timed GPS
metadata. No ExifTool code is vendored, linked, or was consulted while writing any parser here.

## Output

CSV columns:

```
day,timestamp,lat,lon,speed_kmh,heading_deg,altitude_m,magvar_deg,
accel_x,accel_y,accel_z,dt_s,outlier,source_file
```

- **`dt_s`** — seconds since the previous point. Above ~5 is a recording gap; break your polyline
  there. GPX and GeoJSON already do this, one `<trkseg>` / `LineString` per continuous run.
- **`outlier`** — `1` marks a point in a run believed to be a GPS glitch. Flagged, never deleted.

**Timestamps are the camera's own clock and carry no timezone.** dashgps never guesses one;
`--tz-offset -07:00` converts to real UTC.

Full documentation, byte-level format specs and the JavaScript port:
<https://github.com/dashgps/dashgps>

MIT licensed.

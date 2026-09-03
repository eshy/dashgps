# dashgps format specifications

Each format has a spec written **before** its parser. The parser cites clause numbers in comments,
and the spec's Conformance table names the fixture cases that exercise each clause.

| Doc | Format | Status |
|---|---|---|
| [00-model](00-model.md) | Data model, reader abstraction, format registry | — |
| [01-ligogps-ts-trailer](01-ligogps-ts-trailer.md) | LigoGPS trailer after the last TS packet | **Verified** — 1,230 real files |
| [02-ligogps-plaintext](02-ligogps-plaintext.md) | Same records in an MP4 atom or bare TS | Reverse-engineered |
| [03-viidure](03-viidure.md) | Viidure / INNOVV ASCII on TS PID 0x0300 | Untested |
| [04-nmea](04-nmea.md) | NMEA 0183 in TS PES payloads and MP4 atoms | Untested |
| [10-containers](10-containers.md) | MPEG-TS and ISO-BMFF walking rules | — |
| [20-postprocess](20-postprocess.md) | Runs, glitch flagging, `dt_s`, decimated distance | — |
| [21-outputs](21-outputs.md) | CSV, GPX, GeoJSON, summary, ZIP | — |
| [30-formatting](30-formatting.md) | Deterministic formatting — the parity contract | — |
| [40-fixtures](40-fixtures.md) | Fixture generator, goldens, lockstep | — |

**Status vocabulary**

- **Verified** — confirmed against real files from the camera, in quantity.
- **Reverse-engineered** — derived from a real artifact, but not confirmed end-to-end on that camera.
- **Untested** — implemented from a published sample or a public standard. No file from such a
  camera has ever been run through it. Treat output with suspicion and please send us a sample.

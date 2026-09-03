# 03 — Viidure / INNOVV text  (`viidure`)

**Status: untested.** Implemented from a published sample; we have no file from such a camera.
If you own one, please send `dashgps inspect --redact` output — see CONTRIBUTING.

Plain ASCII in the PES payload of TS PID `0x0300`, no framing beyond the magic:

```
Viidure2026/04/16 01:01:02 N:42.211424 W:88.320975 89.1 km/h 267.38 237.80 10 x:-0.001 y:-0.001 z:-0.001
```

Note there is no space between `Viidure` and the date.

| Token | Field |
|---|---|
| `Viidure` + `YYYY/MM/DD` | magic, then date |
| `HH:MM:SS` | time |
| `N:`/`S:` | latitude, decimal degrees |
| `E:`/`W:` | longitude, decimal degrees |
| value, `km/h` | speed |
| next | heading, degrees |
| next | altitude, metres |
| next | unknown — always `10` in the published sample |
| `x:` `y:` `z:` | accelerometer, g |

The unknown field's distinct values are accumulated into `meta.unknown_field_values`, cheap
evidence for a future revision.

Records may split across TS packets, so PES assembly (`10-containers.md` §10.1) is required.
Timestamps are naive, as in `01`.

Fixture cases: `viidure_basic`, `viidure_split_packets`, `viidure_split_chunks`.

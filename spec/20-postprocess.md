# 20 — Post-processing

Carried over unchanged from the prototype that produced the verified 313,303-point corpus.

Defaults: `max_speed_kmh = 400`, `max_gap_s = 600`, `min_run_points = 60`, `decimate_s = 5`.

## 20.1 Order of operations

0. Grouping de-duplicates: consecutive points sharing a timestamp collapse to the first. Two
   sources of duplicates are real — clips overlap at their boundaries, and the receiver sometimes
   emits two fixes stamped with the same second. Left in, they make `dt = 0`, and the run logic
   would read that as a teleport. The count is reported as `dropped_duplicate_times`.
1. No-fix records are already dropped at parse time (see each format spec).
2. Sort points stably by `(t, src, idx)` — see `30-formatting.md` §30.4.
3. Compute `dt_s` and split into runs.
4. Flag glitch runs.
5. Compute per-run distance.

Post-processing runs **after** grouping, so runs may span clip boundaries — a car crossing from one
5-minute clip to the next is one run, not two.

## 20.2 Runs

For each `i >= 1`, with `dt = t[i] - t[i-1]` and `seg_km = haversine(i-1, i)`:

- **gap split** if `dt > max_gap_s` — the camera was off.
- **impossible split** if `seg_km / (dt/3600) > max_speed_kmh`.
- a plain split if `dt <= 0`, which de-duplication should already have made impossible. A repeated
  timestamp is a clock quirk, not a teleport, and must not condemn a run as a glitch.

A split starts a new run at `i`. `dt_s` of the first point in a run is NaN (empty CSV cell).

## 20.3 Glitch flagging

A run is flagged `outlier = 1` — **never deleted** — if and only if:

- it has fewer than `min_run_points` points, **and**
- at least one of its two boundaries is an *impossible* split.

A run bounded only by gap splits is kept regardless of length: a short clip after the ignition was
off is legitimate data.

Rationale for the 400 km/h threshold, which looks absurdly loose: the receiver frequently repeats a
position for one second and then double-steps, which fakes ~220 km/h between adjacent 1 Hz samples
at real highway speed. On the verified corpus, tightening to 200 km/h flagged 20 % of good points.
At 400 km/h it flags 157 points out of 313,303 — and those are real, e.g. a burst where the track
jumps 100 km into the Pacific for 20 seconds before snapping back to Monterey.

## 20.4 Distance

Per run, decimated to at least `decimate_s` between anchors so that 1 Hz jitter does not inflate
the total:

```
total = 0 ; anchor = run[0]
for p in run[1:]:
    if p.t - anchor.t >= decimate_s:
        total += haversine(anchor, p) ; anchor = p
if run[-1] is not anchor:
    total += haversine(anchor, run[-1])
```

Runs flagged as glitches contribute 0. `R = 6371008.8` m.

Undecimated, the verified corpus totals ~7,400 km; decimated, ~7,120 km. The difference is noise.

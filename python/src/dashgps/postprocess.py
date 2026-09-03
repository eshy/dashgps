"""Runs, glitch flagging, dt_s and decimated distance. spec/20-postprocess.md."""

from .fmt import byte_key, haversine_m


class PostOptions:
    __slots__ = ("max_speed_kmh", "max_gap_s", "min_run_points", "decimate_s")

    def __init__(self, max_speed_kmh=400.0, max_gap_s=600.0, min_run_points=60,
                 decimate_s=5.0):
        self.max_speed_kmh = max_speed_kmh
        self.max_gap_s = max_gap_s
        self.min_run_points = min_run_points
        self.decimate_s = decimate_s


class Run:
    __slots__ = ("start", "end", "entry_impossible", "exit_impossible", "glitch", "distance_km")

    def __init__(self, start, end):
        self.start = start
        self.end = end
        self.entry_impossible = False
        self.exit_impossible = False
        self.glitch = False
        self.distance_km = 0.0


def sort_points(points):
    """Stable total order by (t, src, idx). spec 30.4."""
    points.sort(key=lambda p: (p.t, p.src, p.idx))


def postprocess(points, opt):
    """Annotate points in place and return the list of runs."""
    n = len(points)
    if n == 0:
        return []

    # Clause 2 of spec 20.1.
    sort_points(points)

    # Clause 3: split into runs.
    bounds = [0]
    impossible_at = set()
    for i in range(1, n):
        a = points[i - 1]
        b = points[i]
        dt = b.t - a.t
        b.dt_s = dt
        split = False
        imp = False
        if dt > opt.max_gap_s:
            split = True
        elif dt <= 0.0:
            # Only reachable if a caller skipped de-duplication. A repeated timestamp is a clock
            # quirk, not a teleport, so it breaks the run without condemning it as a glitch.
            split = True
        else:
            km = haversine_m(a.lat, a.lon, b.lat, b.lon) / 1000.0
            if km / (dt / 3600.0) > opt.max_speed_kmh:
                split = True
                imp = True
        if split:
            bounds.append(i)
            if imp:
                impossible_at.add(i)
    bounds.append(n)

    runs = []
    for k in range(len(bounds) - 1):
        r = Run(bounds[k], bounds[k + 1])
        r.entry_impossible = bounds[k] in impossible_at
        r.exit_impossible = bounds[k + 1] in impossible_at
        runs.append(r)

    # Clause 4: dt_s is undefined at the start of a run.
    for r in runs:
        points[r.start].dt_s = float("nan")

    # Clause 5: flag, never delete.
    for ri, r in enumerate(runs):
        size = r.end - r.start
        if size < opt.min_run_points and (r.entry_impossible or r.exit_impossible):
            r.glitch = True
        for i in range(r.start, r.end):
            points[i].run = ri
            points[i].outlier = 1 if r.glitch else 0

    # Clause 6: decimated distance.
    for r in runs:
        if r.glitch:
            continue
        total = 0.0
        anchor = points[r.start]
        last = anchor
        for i in range(r.start + 1, r.end):
            p = points[i]
            last = p
            if p.t - anchor.t >= opt.decimate_s:
                total += haversine_m(anchor.lat, anchor.lon, p.lat, p.lon)
                anchor = p
        if last is not anchor:
            total += haversine_m(anchor.lat, anchor.lon, last.lat, last.lon)
        r.distance_km = total / 1000.0
    return runs


def order_sources(names):
    return sorted(names, key=byte_key)

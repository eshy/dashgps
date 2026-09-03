"""Grouping and de-duplication. spec/21-outputs.md."""

from .fmt import byte_key, date_local
from .postprocess import postprocess

DEDUP_EPS = 1e-7


class Group:
    __slots__ = ("label", "points", "runs", "sources", "dropped_dupe")

    def __init__(self, label):
        self.label = label
        self.points = []
        self.runs = []
        self.sources = []
        self.dropped_dupe = 0


def _stem(name):
    i = name.rfind("/")
    if i >= 0:
        name = name[i + 1 :]
    i = name.rfind("\\")
    if i >= 0:
        name = name[i + 1 :]
    j = name.rfind(".")
    return name[:j] if j > 0 else name


def dedupe(points):
    """Collapse consecutive points that share a timestamp. Returns (points, dropped).

    Two sources of duplicates, both real: clips overlap at their boundaries, and the receiver
    sometimes emits two fixes stamped with the same second. Keeping both would leave dt = 0, which
    the run logic cannot interpret - it would look like a teleport and flag good data as a glitch.

    We keep the FIRST of each duplicated second. On the verified corpus the choice is a coin flip
    for accuracy (of 39 duplicate pairs in a day, the first fits its neighbours better in 19 cases
    and the last in 19; total path length differs by 0.05%), so it is settled by compatibility:
    the first is what the original extraction kept, and downstream CSVs depend on it.
    """
    out = []
    dropped = 0
    for p in points:
        if out and out[-1].t == p.t:
            dropped += 1
            continue
        out.append(p)
    return out, dropped


def group_results(results, mode, post_opt):
    """Bucket points, dedupe, then post-process. Post-processing runs AFTER grouping so a run
    can span clip boundaries. spec 20.1."""
    buckets = {}
    order = []
    for res in results:
        src = res.sources[0] if res.sources else "?"
        for p in res.points:
            if mode == "day":
                label = date_local(p.t)
            elif mode == "file":
                label = _stem(src)
            else:
                label = "all"
            g = buckets.get(label)
            if g is None:
                g = Group(label)
                buckets[label] = g
                order.append(label)
            g.points.append(p)
            if src not in g.sources:
                g.sources.append(src)

    groups = []
    for label in sorted(order, key=byte_key):
        g = buckets[label]
        g.points.sort(key=lambda p: (p.t, p.src, p.idx))
        g.points, g.dropped_dupe = dedupe(g.points)
        g.sources.sort(key=byte_key)
        g.runs = postprocess(g.points, post_opt)
        groups.append(g)
    return groups

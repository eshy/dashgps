"""Format registry and auto-detection. spec/00-model.md.

Sniffing is budgeted by declared IO cost. That is what stops one non-matching file in a batch of
1,200 from triggering a full-file scan.
"""

from .model import NoFormatMatch, ParseError

COST_RANK = {"tail": 0, "head": 1, "full-scan": 2}


class FormatSpec:
    __slots__ = ("id", "name", "status", "cost", "extensions", "sniff", "parse", "order")

    def __init__(self, fid, name, status, cost, extensions, sniff, parse, order):
        self.id = fid
        self.name = name
        self.status = status
        self.cost = cost
        self.extensions = extensions
        self.sniff = sniff
        self.parse = parse
        self.order = order


_REGISTRY = []


def register(fid, name, status, cost, extensions, sniff, parse):
    _REGISTRY.append(
        FormatSpec(fid, name, status, cost, extensions, sniff, parse, len(_REGISTRY))
    )


def formats():
    return list(_REGISTRY)


def by_id(fid):
    for f in _REGISTRY:
        if f.id == fid:
            return f
    return None


def sniff_all(reader, opts):
    """Every format's score, in registration order. Used by `dashgps inspect`."""
    out = []
    for spec in _REGISTRY:
        try:
            score = spec.sniff(reader, opts)
        except Exception:
            score = 0.0
        out.append((spec.id, score))
    return out


def _best(cands):
    # Ties break by score, then cheaper IO cost, then registration order. spec 00.
    best = None
    for spec, score in cands:
        key = (-score, COST_RANK[spec.cost], spec.order)
        if best is None or key < best[0]:
            best = (key, spec, score)
    return (best[1], best[2]) if best else (None, 0.0)


def parse_auto(reader, opts, only=None):
    """Detect and parse. Raises NoFormatMatch with every score attached."""
    opts.probe = {}
    if only:
        spec = by_id(only)
        if spec is None:
            raise ParseError("unknown format id: %s" % only)
        return spec.parse(reader, opts)

    scores = []
    for tier, threshold in (("tail", 0.9), ("head", 0.9), ("full-scan", 0.5)):
        if tier == "full-scan" and not opts.deep:
            continue
        cands = []
        confident = None
        for spec in _REGISTRY:
            if spec.cost != tier:
                continue
            try:
                score = spec.sniff(reader, opts)
            except Exception:
                score = 0.0
            scores.append((spec.id, score))
            if score > 0.0:
                cands.append((spec, score))
            # Short-circuit: a confident hit stops the tier, so we never run an expensive
            # scan for a format we are not going to choose. Registration order decides.
            if score >= 0.9:
                confident = spec
                break
        if confident is not None:
            return confident.parse(reader, opts)
        spec, score = _best(cands)
        if spec is not None and score >= threshold:
            return spec.parse(reader, opts)
    raise NoFormatMatch(scores)

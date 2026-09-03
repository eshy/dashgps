"""Core data types. spec/00-model.md."""

from .fmt import NAN


class Point:
    __slots__ = (
        "t", "lat", "lon", "speed_kmh", "heading_deg", "alt_m", "magvar_deg",
        "ax", "ay", "az", "idx", "src", "dt_s", "run", "outlier",
    )

    def __init__(self, t, lat, lon, speed_kmh=NAN, heading_deg=NAN, alt_m=NAN,
                 magvar_deg=NAN, ax=NAN, ay=NAN, az=NAN, idx=-1, src=0):
        self.t = t
        self.lat = lat
        self.lon = lon
        self.speed_kmh = speed_kmh
        self.heading_deg = heading_deg
        self.alt_m = alt_m
        self.magvar_deg = magvar_deg
        self.ax = ax
        self.ay = ay
        self.az = az
        self.idx = idx
        self.src = src
        self.dt_s = NAN
        self.run = 0
        self.outlier = 0


class ParseResult:
    def __init__(self, format_id, status, sources=None, points=None, meta=None,
                 warnings=None, dropped_nofix=0, time_is_naive=True):
        self.format_id = format_id
        self.status = status
        self.sources = sources if sources is not None else []
        self.points = points if points is not None else []
        self.meta = meta if meta is not None else {}
        self.warnings = warnings if warnings is not None else []
        self.dropped_nofix = dropped_nofix
        self.time_is_naive = time_is_naive
        self.error = None

    def warn(self, msg):
        # Deduplicated by first occurrence: a resync that fires 300 times is one line, not 300.
        if msg not in self.warnings:
            self.warnings.append(msg)


class ParseOptions:
    __slots__ = ("tail_cap", "chunk", "overlap", "deep", "tz_offset_s", "raw_nmea",
                 "scan_cap", "probe")

    def __init__(self, tail_cap=1024 * 1024, chunk=4 * 1024 * 1024, overlap=4096,
                 deep=True, tz_offset_s=0, raw_nmea=False, scan_cap=64 * 1024 * 1024):
        self.tail_cap = tail_cap
        self.chunk = chunk
        self.overlap = overlap
        self.deep = deep
        self.tz_offset_s = tz_offset_s
        self.raw_nmea = raw_nmea
        # A full-scan format reads at most this much from each end of the file. Without it, one
        # clip that matches nothing costs a whole pass over a gigabyte, per format.
        self.scan_cap = scan_cap
        # Per-file memo, reset by parse_auto, so a probe done during sniff is not repeated
        # during parse.
        self.probe = {}


class ParseError(Exception):
    pass


class NoFormatMatch(Exception):
    def __init__(self, scores):
        Exception.__init__(self, "no known GPS format matched")
        self.scores = scores

"""Viidure / INNOVV ASCII records in a TS private stream.

Implements spec/03-viidure.md.

Status: UNTESTED. Written from a record published in a public bug report; no file from such a
camera has ever been run through it. If you own one, please send `dashgps inspect --redact`.
"""

from ..containers.ts import detect_alignment, iter_pes
from ..fmt import NAN, epoch_from_civil, parse_num
from ..ligo_record import _coord, _date_parts, _time_parts, split_tokens
from ..model import ParseError, ParseResult, Point

FORMAT_ID = "viidure"
STATUS = "untested"

MAGIC = b"Viidure"
PID = 0x0300


def _parse_text(text):
    """Returns (fields dict, unknown) or None. spec 03."""
    toks = split_tokens(text)
    if len(toks) < 6:
        return None
    dp = _date_parts(toks[0])
    tp = _time_parts(toks[1])
    if dp is None or tp is None:
        return None
    lat = _coord(toks[2], "N", "S")
    lon = _coord(toks[3], "E", "W")
    if lat is None or lon is None or toks[5] != "km/h":
        return None
    out = {
        "t": epoch_from_civil(dp[0], dp[1], dp[2], tp[0], tp[1], tp[2]),
        "lat": lat, "lon": lon, "speed": parse_num(toks[4]),
        "heading": NAN, "alt": NAN, "ax": NAN, "ay": NAN, "az": NAN,
    }
    unknown = None
    bare = []
    for tok in toks[6:]:
        if len(tok) >= 3 and tok[1] == ":":
            k = tok[0]
            v = parse_num(tok[2:])
            if k == "x":
                out["ax"] = v
            elif k == "y":
                out["ay"] = v
            elif k == "z":
                out["az"] = v
        else:
            bare.append(parse_num(tok))
    # After km/h the published sample carries: track, altitude, then an unknown constant.
    if len(bare) >= 1:
        out["heading"] = bare[0]
    if len(bare) >= 2:
        out["alt"] = bare[1]
    if len(bare) >= 3:
        unknown = bare[2]
    if out["lat"] == 0.0 and out["lon"] == 0.0:
        return None
    return out, unknown


def _iter_records(reader, opts):
    stride, off = detect_alignment(reader)
    if stride == 0:
        return
    # GPS in a TS private stream is interleaved throughout, so the head of the file is
    # representative: if the stream is there at all, it is in the first scan_cap bytes.
    end = reader.size()
    if 0 < opts.scan_cap < end:
        end = opts.scan_cap
    for _pid, payload in iter_pes(reader, stride, off, (PID,), opts.chunk, end=end):
        p = 0
        while True:
            hit = payload.find(MAGIC, p)
            if hit < 0:
                break
            start = hit + len(MAGIC)
            stop = payload.find(b"\x00", start)
            if stop < 0:
                stop = len(payload)
            nxt = payload.find(MAGIC, start)
            if 0 <= nxt < stop:
                stop = nxt
            try:
                yield payload[start:stop].decode("ascii")
            except UnicodeDecodeError:
                pass
            p = start


def sniff(reader, opts):
    if not opts.deep:
        return 0.0
    for text in _iter_records(reader, opts):
        if _parse_text(text) is not None:
            return 0.85
        break
    return 0.0


def parse(reader, opts):
    res = ParseResult(FORMAT_ID, STATUS, sources=[reader.name])
    tz = opts.tz_offset_s
    unknowns = []
    n = 0
    for text in _iter_records(reader, opts):
        n += 1
        got = _parse_text(text)
        if got is None:
            res.warn("unparsable Viidure record")
            continue
        f, unknown = got
        if unknown is not None and unknown == unknown and unknown not in unknowns:
            unknowns.append(unknown)
        res.points.append(Point(f["t"] - tz, f["lat"], f["lon"], f["speed"], f["heading"],
                                f["alt"], NAN, f["ax"], f["ay"], f["az"], -1, 0))
    if n == 0:
        raise ParseError("no Viidure records found")
    res.meta["records"] = n
    # Cheap evidence for a future revision of the spec.
    res.meta["unknown_field_values"] = unknowns
    return res

"""NMEA 0183 sentences embedded in TS private streams or MP4 atoms.

Implements spec/04-nmea.md. NMEA is a published standard, so this parser is the catch-all that
gives dashgps a chance on cameras nobody has documented.

Status: UNTESTED against a real dashcam; the wire format itself is standard.
"""

from ..containers.mp4 import iter_atoms, looks_like_mp4
from ..containers.ts import WELL_KNOWN_PIDS, detect_alignment, iter_pes
from ..fmt import NAN, epoch_from_civil, parse_num
from ..io import capped_windows, scan_chunks
from ..model import ParseError, ParseResult, Point

FORMAT_ID = "nmea"
STATUS = "untested"

ATOMS = (b"free", b"skip", b"udta", b"gps ")
KNOTS_TO_KMH = 1.852


def _checksum_ok(body, given):
    x = 0
    for b in body:
        x ^= b
    hi = "0123456789ABCDEF"[(x >> 4) & 15]
    lo = "0123456789ABCDEF"[x & 15]
    return given.upper() == hi + lo


def iter_sentences(buf):
    """Yield (talker_and_type, fields, ok) for every $-delimited candidate."""
    i = 0
    n = len(buf)
    while True:
        s = buf.find(b"$", i)
        if s < 0:
            return
        e = s + 1
        while e < n and buf[e] not in (0x24, 0x00, 0x0D, 0x0A):
            e += 1
        raw = buf[s + 1 : e]
        i = e if e > s else s + 1
        if len(raw) < 7:
            continue
        star = raw.rfind(b"*")
        ok = True
        if star >= 0 and len(raw) - star >= 3:
            ok = _checksum_ok(raw[:star], raw[star + 1 : star + 3].decode("ascii", "replace"))
            raw = raw[:star]
        try:
            text = raw.decode("ascii")
        except UnicodeDecodeError:
            continue
        parts = text.split(",")
        if not parts or len(parts[0]) < 5:
            continue
        yield parts[0], parts, ok


def _dm_to_deg(v, hemi, pos):
    if v != v:
        return NAN
    deg = int(v / 100.0)
    out = deg + (v - deg * 100.0) / 60.0
    return out if hemi == pos else -out


def _rmc(parts):
    # time, status, lat, NS, lon, EW, knots, track, date, magvar, magvarEW
    if len(parts) < 10 or parts[2] != "A":
        return None
    tm = parts[1]
    dt = parts[9]
    if len(tm) < 6 or len(dt) != 6:
        return None
    try:
        hh = int(tm[0:2])
        mi = int(tm[2:4])
        ss = int(tm[4:6])
        dd = int(dt[0:2])
        mo = int(dt[2:4])
        yy = int(dt[4:6])
    except ValueError:
        return None
    year = 1900 + yy if yy >= 70 else 2000 + yy
    if mo < 1 or mo > 12 or dd < 1 or dd > 31 or hh > 23 or mi > 59 or ss > 60:
        return None
    lat = _dm_to_deg(parse_num(parts[3]), parts[4], "N")
    lon = _dm_to_deg(parse_num(parts[5]), parts[6], "E")
    if lat != lat or lon != lon:
        return None
    kn = parse_num(parts[7])
    magvar = NAN
    if len(parts) >= 12:
        mv = parse_num(parts[10])
        if mv == mv:
            magvar = mv if parts[11] == "E" else -mv
    return {
        "key": tm,
        "t": epoch_from_civil(year, mo, dd, hh, mi, 59 if ss == 60 else ss),
        "lat": lat, "lon": lon,
        "speed": kn * KNOTS_TO_KMH if kn == kn else NAN,
        "track": parse_num(parts[8]),
        "magvar": magvar,
    }


def _gga(parts):
    if len(parts) < 10:
        return None
    return {"key": parts[1], "alt": parse_num(parts[9])}


def _buffers(reader, opts):
    """Yield byte buffers that might contain NMEA, from whichever container this is."""
    if looks_like_mp4(reader):
        cap = opts.tail_cap if opts.tail_cap > 0 else 1024 * 1024
        for a in iter_atoms(reader):
            if a.type in ATOMS and 0 < a.body_size <= cap:
                yield reader.read_range(a.body, a.end)
        return
    stride, off = detect_alignment(reader)
    if stride:
        end = reader.size()
        if 0 < opts.scan_cap < end:
            end = opts.scan_cap
        for _pid, payload in iter_pes(reader, stride, off, WELL_KNOWN_PIDS, opts.chunk, end=end):
            yield payload
        return
    if opts.raw_nmea:
        for start, stop in capped_windows(reader.size(), opts.scan_cap):
            for slab, _first in scan_chunks(reader, opts.chunk, opts.overlap, start, stop):
                yield slab.data


def _collect(reader, opts, res, limit=0):
    pend_rmc = None
    pend_gga = None
    pend_key = None
    rejects = 0
    seen = 0
    out = []

    def flush():
        if pend_rmc is None:
            return
        alt = pend_gga["alt"] if pend_gga is not None else NAN
        out.append(Point(pend_rmc["t"] - 0, pend_rmc["lat"], pend_rmc["lon"],
                         pend_rmc["speed"], pend_rmc["track"], alt, pend_rmc["magvar"],
                         NAN, NAN, NAN, -1, 0))

    for buf in _buffers(reader, opts):
        for kind, parts, ok in iter_sentences(buf):
            t = kind[2:5]
            if t not in ("RMC", "GGA"):
                continue
            if not ok:
                rejects += 1
                continue
            seen += 1
            key = parts[1] if len(parts) > 1 else ""
            # Pairing is on the NMEA time field, not on line order. spec 04.
            if pend_key is not None and key != pend_key:
                flush()
                pend_rmc = None
                pend_gga = None
            pend_key = key
            if t == "RMC":
                r = _rmc(parts)
                if r is not None:
                    pend_rmc = r
            else:
                g = _gga(parts)
                if g is not None:
                    pend_gga = g
            if limit and len(out) >= limit:
                return out, seen, rejects
    flush()
    return out, seen, rejects


def sniff(reader, opts):
    if not opts.deep:
        return 0.0
    pts, seen, _ = _collect(reader, opts, ParseResult(FORMAT_ID, STATUS), limit=1)
    if pts:
        return 0.7
    return 0.0


def parse(reader, opts):
    res = ParseResult(FORMAT_ID, STATUS, sources=[reader.name], time_is_naive=False)
    pts, seen, rejects = _collect(reader, opts, res)
    res.meta["sentences"] = seen
    res.meta["checksum_rejects"] = rejects
    if rejects:
        res.warn("%d NMEA sentences failed their checksum and were ignored" % rejects)
    if not pts:
        if seen:
            # GGA carries no date, so a GGA-only stream cannot produce absolute timestamps.
            raise ParseError("NMEA sentences found but none carried a valid RMC fix")
        raise ParseError("no NMEA sentences found")
    res.points = pts
    return res

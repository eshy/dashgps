"""LigoGPS plaintext records without the trailer wrapper.

Implements spec/02-ligogps-plaintext.md. Record parsing is identical to ligo.ts_trailer
clauses 4-8; only discovery differs.

Status: reverse-engineered. The record grammar is verified; this placement is not.
"""

from ..containers.mp4 import iter_atoms, looks_like_mp4
from ..io import capped_windows, read_slab, scan_chunks
from ..ligo_record import (
    LIGO_MAGIC,
    detect_stride,
    is_ascii_region,
    is_date_shape,
    parse_ligo_text,
    record_text,
)
from ..model import ParseError, ParseResult, Point

FORMAT_ID = "ligo.plain"
STATUS = "reverse-engineered"

ATOMS = (b"skip", b"free", b"udta", b"gps ")
HEAD_BUDGET = 256 * 1024


def _find_in_mp4(reader):
    """Return (ligo_abs_off, block_end) for the last matching atom, or None."""
    if not looks_like_mp4(reader):
        return None
    found = None
    for a in iter_atoms(reader):
        if a.type not in ATOMS or a.body_size < 0x20:
            continue
        probe = read_slab(reader, a.body, a.body + len(LIGO_MAGIC))
        if len(probe) < len(LIGO_MAGIC):
            continue
        if probe.bytes(a.body, len(LIGO_MAGIC)) != LIGO_MAGIC:
            continue
        found = (a.body, a.end)
    return found


def _find_in_scan(reader, opts):
    """Full-scan fallback: the last LIGOGPSINFO in the head or tail window of the file."""
    found = None
    for start, end in capped_windows(reader.size(), opts.scan_cap):
        for slab, first in scan_chunks(reader, opts.chunk, opts.overlap, start, end):
            p = slab.base
            while True:
                hit = slab.find(LIGO_MAGIC, p, slab.end)
                if hit < 0:
                    break
                if first or hit >= slab.base + opts.overlap:
                    found = (hit, reader.size())
                p = hit + 1
    return found


def _locate(reader, opts):
    hit = _find_in_mp4(reader)
    if hit is not None:
        return hit, "mp4"
    if opts.deep:
        hit = _find_in_scan(reader, opts)
        if hit is not None:
            return hit, "scan"
    return None, None


def sniff(reader, opts):
    # Cheap path first: an MP4 atom walk is a few dozen small reads. Only fall back to a full
    # scan when the caller has asked for deep detection.
    if _find_in_mp4(reader) is not None:
        return 0.9
    if not opts.deep:
        return 0.0
    return 0.6 if _find_in_scan(reader, opts) is not None else 0.0


def parse(reader, opts):
    res = ParseResult(FORMAT_ID, STATUS, sources=[reader.name])
    hit, how = _locate(reader, opts)
    if hit is None:
        raise ParseError("no LIGOGPSINFO header found")
    lig, block_end = hit
    res.meta["found_in"] = how

    cap = opts.tail_cap if opts.tail_cap > 0 else 1024 * 1024
    if block_end - lig > cap:
        block_end = lig + cap
        res.warn("LIGOGPSINFO block larger than the read cap; parsing the first %d bytes" % cap)
    slab = read_slab(reader, lig, block_end)
    first = lig + 0x14
    if not is_ascii_region(slab, first + 4, 96) or not is_date_shape(slab, first + 4):
        raise ParseError("LIGOGPSINFO block does not hold ASCII records")

    res.meta["variant"] = slab.u8(lig + 0x0B) if slab.covers(lig + 0x0B, 1) else -1
    count_field = slab.u32be(lig + 0x10) if slab.covers(lig + 0x10, 4) else 0
    res.meta["count_field"] = count_field

    stride, warn = detect_stride(slab, first, slab.end)
    if warn:
        res.warn(warn)
    if stride <= 0:
        raise ParseError("could not determine record stride")
    res.meta["stride"] = stride

    derived = (slab.end - first) // stride
    count = count_field if 0 < count_field <= derived else derived
    res.meta["records"] = count

    tz = opts.tz_offset_s
    dropped = 0
    for i in range(count):
        off = first + i * stride
        idx = slab.u32be(off) if slab.covers(off, 4) else -1
        text = record_text(slab, off, stride)
        if not text:
            continue
        f = parse_ligo_text(text)
        if f is None:
            res.warn("unparsable record at index %d" % i)
            continue
        if f.nofix:
            dropped += 1
            continue
        res.points.append(Point(f.t - tz, f.lat, f.lon, f.speed_kmh, f.heading_deg,
                                f.alt_m, f.magvar_deg, f.ax, f.ay, f.az, idx, 0))
    res.dropped_nofix = dropped
    return res

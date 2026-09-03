"""LigoGPS trailer appended after the last TS packet.

Implements spec/01-ligogps-ts-trailer.md. Clause numbers in comments refer to §1.6.

Status: VERIFIED against ~1,230 real ICESKY files. This is the format dashgps exists for.
"""

from ..io import read_slab
from ..ligo_record import (
    LIGO_MAGIC,
    detect_stride,
    is_ascii_region,
    is_date_shape,
    parse_ligo_text,
    record_text,
)
from ..model import ParseError, ParseResult, Point

FORMAT_ID = "ligo.ts_trailer"
STATUS = "verified"

END_MAGICS = (b"####", b"&&&&")
TAGS = (b"SKIP", b"skip")
FOOTER_PROBE = 65536  # the tail sniff budget, spec 00. One read covers a typical
                      # whole trailer, so a clip costs a single seek.
MAX_BLOCKS = 256


def _memo(opts, value):
    if opts is not None:
        opts.probe["ligo.footer"] = value
    return value


def _footer(reader, opts=None):
    """Clause 1. Returns (slab, trailer_len, magic) or None.

    Memoized on opts.probe: sniff and parse both need the footer, and on a network filesystem a
    second round trip per file is the difference between seconds and minutes over a big folder.
    """
    if opts is not None and "ligo.footer" in opts.probe:
        return opts.probe["ligo.footer"]
    n = reader.size()
    if n < 32:
        return _memo(opts, None)
    slab = read_slab(reader, n - FOOTER_PROBE if n > FOOTER_PROBE else 0, n)
    if not slab.covers(n - 8, 8):
        return _memo(opts, None)
    magic = slab.bytes(n - 8, 4)
    if magic not in END_MAGICS:
        return _memo(opts, None)
    length = slab.u32be(n - 4)
    if length < 8 or length > n:
        return _memo(opts, None)
    out = (slab, length, magic)
    if opts is not None:
        opts.probe["ligo.footer"] = out
    return out


def sniff(reader, opts):
    return 0.95 if _footer(reader, opts) is not None else 0.0


def _read_header(slab, off, tr_end):
    """Block header at off, or None. Clause 3."""
    if off + 8 > tr_end or not slab.covers(off, 8):
        return None
    if slab.bytes(off + 4, 4) not in TAGS:
        return None
    return slab.u32be(off)


def _resync(slab, after, tr_end, tr_start, res):
    """Find the next plausible block header. Clause 3."""
    p = after
    while True:
        a = slab.find(b"SKIP", p, tr_end)
        b = slab.find(b"skip", p, tr_end)
        if a < 0:
            hit = b
        elif b < 0:
            hit = a
        else:
            hit = a if a < b else b
        if hit < 0:
            return -1
        start = hit - 4
        if start >= slab.base and _read_header(slab, start, tr_end) is not None:
            sz = slab.u32be(start)
            if 8 <= sz <= (tr_end - start) + 8:
                # Offset from the start of the trailer: stable regardless of how much
                # of the file the reader happened to buffer.
                res.warn("resynchronised to block header at trailer+%d" % (start - tr_start))
                return start
        p = hit + 4


def parse(reader, opts):
    res = ParseResult(FORMAT_ID, STATUS, sources=[reader.name])
    n = reader.size()

    f = _footer(reader, opts)
    if f is None:
        raise ParseError("no LigoGPS trailer footer")
    foot, length, magic = f
    res.meta["end_magic"] = magic.decode("ascii")
    res.meta["trailer_len"] = length

    # Clause 2. Reuse the footer probe when the whole trailer already fits inside it.
    tr_start = n - length
    read_from = tr_start
    if length > opts.tail_cap:
        read_from = n - opts.tail_cap
        res.warn(
            "trailer is %d bytes, larger than the %d-byte cap; parsing the tail only"
            % (length, opts.tail_cap)
        )
    slab = foot if foot.base <= read_from else read_slab(reader, read_from, n)
    tr_end = n - 8

    # Clause 3: walk the blocks.
    blocks = []
    pos = tr_start if tr_start >= slab.base else slab.base
    guard = 0
    while pos + 8 <= tr_end and guard < MAX_BLOCKS:
        guard += 1
        sz = _read_header(slab, pos, tr_end)
        if sz is None:
            pos = _resync(slab, pos + 1, tr_end, tr_start, res)
            if pos < 0:
                break
            continue
        nxt = -1
        for cand in (pos + sz, pos + sz + 8):
            if cand <= pos:
                continue
            if cand == tr_end or cand >= tr_end:
                nxt = tr_end
                break
            if _read_header(slab, cand, tr_end) is not None:
                nxt = cand
                break
        if nxt < 0:
            r = _resync(slab, pos + 8, tr_end, tr_start, res)
            nxt = r if r > pos else tr_end
        blocks.append((pos, nxt))
        pos = nxt
    res.meta["blocks"] = len(blocks)

    # Clauses 4 and 5: keep the last block that holds ASCII GPS records.
    chosen = None
    for start, end in blocks:
        lig = start + 8
        if not slab.covers(lig, len(LIGO_MAGIC)):
            continue
        if slab.bytes(lig, len(LIGO_MAGIC)) != LIGO_MAGIC:
            continue
        first = lig + 0x14
        # The record body starts after the 4-byte binary index, so the ASCII test starts there.
        if not is_ascii_region(slab, first + 4, 96):
            continue
        if not is_date_shape(slab, first + 4):
            continue
        chosen = (lig, first, end)
    if chosen is None:
        raise ParseError("trailer has no ASCII LIGOGPSINFO block")
    lig, first, block_end = chosen

    res.meta["variant"] = slab.u8(lig + 0x0B) if slab.covers(lig + 0x0B, 1) else -1
    count_field = slab.u32be(lig + 0x10) if slab.covers(lig + 0x10, 4) else 0
    res.meta["count_field"] = count_field

    # Clause 6.
    stride, warn = detect_stride(slab, first, block_end)
    if warn:
        res.warn(warn)
    if stride <= 0:
        raise ParseError("could not determine record stride")
    res.meta["stride"] = stride

    # Clause 7.
    derived = (block_end - first) // stride
    if derived < 0:
        derived = 0
    count = count_field if count_field > 0 else derived
    if count > derived:
        if count_field > 0:
            res.warn(
                "record count field says %d but only %d records fit; using %d"
                % (count_field, derived, derived)
            )
        count = derived
    elif count_field > 0 and derived - count_field > 1:
        res.warn("record count field says %d but %d records fit" % (count_field, derived))
    res.meta["records"] = count

    # Clause 8.
    tz = opts.tz_offset_s
    dropped = 0
    for i in range(count):
        off = first + i * stride
        idx = slab.u32be(off) if slab.covers(off, 4) else -1
        text = record_text(slab, off, stride)
        if not text:
            continue
        fields = parse_ligo_text(text)
        if fields is None:
            res.warn("unparsable record at index %d" % i)
            continue
        if fields.nofix:
            dropped += 1
            continue
        res.points.append(
            Point(
                fields.t - tz, fields.lat, fields.lon, fields.speed_kmh, fields.heading_deg,
                fields.alt_m, fields.magvar_deg, fields.ax, fields.ay, fields.az, idx, 0,
            )
        )
    res.dropped_nofix = dropped
    return res

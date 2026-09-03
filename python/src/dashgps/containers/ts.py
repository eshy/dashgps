"""MPEG-TS packet and PES walking. spec/10-containers.md §10.1."""

from ..io import scan_chunks

SYNC = 0x47
STRIDES = (188, 192, 204)
MIN_HITS = 3
CONFIRM_HITS = 20

# PIDs dashcams are known to use for GPS. We do not gate on the PMT: these cameras routinely
# omit the GPS program from it entirely. spec 10.1.
WELL_KNOWN_PIDS = (0x0300, 0x0102, 0x01E4, 0x0E1B)

_NO_SYNTAX = frozenset((0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF))


def detect_alignment(reader, limit=65536):
    """Return (stride, offset) or (0, 0) if this is not a TS stream."""
    n = reader.size()
    head = reader.read_range(0, limit if limit < n else n)
    best = (0, 0, 0)
    for stride in STRIDES:
        for off in range(0, stride):
            if off >= len(head):
                break
            if head[off] != SYNC:
                continue
            avail = (len(head) - off + stride - 1) // stride
            want = CONFIRM_HITS if avail > CONFIRM_HITS else avail
            hits = 0
            p = off
            while p < len(head):
                if head[p] != SYNC:
                    break
                hits += 1
                p += stride
            if hits >= MIN_HITS and hits >= want and hits > best[2]:
                best = (stride, off, hits)
                if hits >= CONFIRM_HITS:
                    return stride, off
    return (best[0], best[1]) if best[0] else (0, 0)


def iter_packets(reader, stride, offset, pids, chunk=4 * 1024 * 1024, end=None):
    """Yield (pid, pusi, payload) for packets whose PID is in ``pids``.

    Reads in chunks aligned to the packet stride so a packet is never split across two reads.
    """
    n = reader.size() if end is None else end
    per = chunk // stride
    if per < 1:
        per = 1
    step = per * stride
    pos = offset
    while pos + stride <= n:
        stop = pos + step
        if stop > n:
            stop = n
        buf = reader.read_range(pos, stop)
        i = 0
        while i + stride <= len(buf):
            if buf[i] != SYNC:
                i += stride
                continue
            b1 = buf[i + 1]
            b2 = buf[i + 2]
            pid = ((b1 & 0x1F) << 8) | b2
            if pid in pids:
                b3 = buf[i + 3]
                if b3 & 0x10:  # has payload
                    j = i + 4
                    if b3 & 0x20:  # adaptation field
                        j += 1 + buf[j]
                    if j < i + 188:
                        yield pid, bool(b1 & 0x40), buf[j : i + 188]
            i += stride
        if stop >= n:
            break
        pos = pos + (len(buf) // stride) * stride
        if pos >= stop:
            pos = stop


def strip_pes_header(payload):
    """Return the payload after any PES header. spec 10.1."""
    if len(payload) >= 6 and payload[0] == 0 and payload[1] == 0 and payload[2] == 1:
        sid = payload[3]
        if sid in _NO_SYNTAX:
            return payload[6:]
        if len(payload) >= 9:
            return payload[9 + payload[8] :]
        return b""
    return payload


def iter_pes(reader, stride, offset, pids, chunk=4 * 1024 * 1024, tolerate_no_pusi=True,
             cap=65536, end=None):
    """Assemble and yield PES payloads per PID.

    Some dashcams never set payload_unit_start_indicator on their GPS PID, so when
    ``tolerate_no_pusi`` is set the payload simply accumulates until the cap. spec 10.1.
    """
    bufs = {}
    seen_pusi = {}
    for pid, pusi, payload in iter_packets(reader, stride, offset, pids, chunk, end):
        if pusi:
            seen_pusi[pid] = True
            prev = bufs.get(pid)
            if prev:
                yield pid, strip_pes_header(bytes(prev))
            bufs[pid] = bytearray(payload)
        else:
            cur = bufs.get(pid)
            if cur is None:
                if not tolerate_no_pusi and not seen_pusi.get(pid):
                    continue
                cur = bytearray()
                bufs[pid] = cur
            if len(cur) < cap:
                cur.extend(payload)
    for pid, buf in bufs.items():
        if buf:
            yield pid, strip_pes_header(bytes(buf))


def iter_raw_chunks(reader, opts, start=0, end=None):
    """Overlapping raw slabs, for scanners that do not care about packet framing."""
    return scan_chunks(reader, opts.chunk, opts.overlap, start, end)

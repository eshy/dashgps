"""Lazy ISO-BMFF (MP4/MOV) atom walking. spec/10-containers.md §10.2.

Never reads an atom's payload unless asked, so walking a 1 GB file costs a few dozen small reads.
"""

from ..io import read_slab

CONTAINERS = frozenset(
    (b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"moof", b"traf", b"mvex")
)

FTYP_BRANDS = frozenset((b"ftyp", b"styp", b"moov", b"free", b"skip", b"mdat", b"wide", b"pnot"))


class Atom:
    __slots__ = ("type", "start", "body", "end", "path")

    def __init__(self, atype, start, body, end, path):
        self.type = atype
        self.start = start
        self.body = body
        self.end = end
        self.path = path

    @property
    def body_size(self):
        return self.end - self.body


def looks_like_mp4(reader):
    """Cheap structural check: a plausible top-level atom at offset 0."""
    n = reader.size()
    if n < 16:
        return False
    head = reader.read_range(0, 16)
    if len(head) < 16:
        return False
    size = (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]
    atype = head[4:8]
    if atype not in FTYP_BRANDS:
        return False
    return size == 0 or size == 1 or (8 <= size <= n)


def iter_atoms(reader, start=0, end=None, path="", depth=0, max_depth=6, max_atoms=4096):
    """Yield Atom objects depth-first. Recurses into known container types."""
    n = reader.size() if end is None else end
    pos = start
    count = 0
    while pos + 8 <= n and count < max_atoms:
        hdr = read_slab(reader, pos, pos + 16)
        if len(hdr) < 8:
            return
        size = hdr.u32be(pos)
        atype = hdr.bytes(pos + 4, 4)
        body = pos + 8
        if size == 1:
            if len(hdr) < 16:
                return
            size = hdr.u64be(pos + 8)
            body = pos + 16
        elif size == 0:
            size = n - pos
        if size < (body - pos) or pos + size > n:
            return
        aend = pos + size
        a = Atom(atype, pos, body, aend, path + "/" + atype.decode("latin-1"))
        yield a
        count += 1
        if atype in CONTAINERS and depth < max_depth:
            for sub in iter_atoms(reader, body, aend, a.path, depth + 1, max_depth, max_atoms):
                yield sub
        pos = aend

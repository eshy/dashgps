"""Reader abstraction and byte-slab helpers. spec/00-model.md.

Parsers never open files and never read a whole file. They receive a Reader and pull the ranges
they need, which is what makes a 1 GB clip cost ~50 KB of IO and lets the identical parser run
over a browser Blob.
"""


class BytesReader:
    """Reader over an in-memory buffer. Used by tests and by nested parses."""

    def __init__(self, data, name="<bytes>"):
        self._d = data
        self.name = name

    def size(self):
        return len(self._d)

    def read_range(self, start, end):
        if start < 0:
            start = 0
        if end > len(self._d):
            end = len(self._d)
        if end <= start:
            return b""
        return self._d[start:end]


class FileReader:
    """Reader over a file on disk. Seeks; never reads more than asked for."""

    def __init__(self, path, name=None):
        self.path = path
        self.name = name if name is not None else path
        self._f = open(path, "rb")
        self._f.seek(0, 2)
        self._size = self._f.tell()

    def size(self):
        return self._size

    def read_range(self, start, end):
        if start < 0:
            start = 0
        if end > self._size:
            end = self._size
        if end <= start:
            return b""
        self._f.seek(start)
        return self._f.read(end - start)

    def close(self):
        self._f.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class CountingReader:
    """Wraps a reader and records every range read.

    The recorded trace is asserted by the test suite, which is how "dashgps only reads the tail of
    your file" stays a tested property rather than a claim. spec/40-fixtures.md.
    """

    def __init__(self, inner):
        self._r = inner
        self.name = inner.name
        self.ranges = []
        self.bytes_read = 0

    def size(self):
        return self._r.size()

    def read_range(self, start, end):
        b = self._r.read_range(start, end)
        self.ranges.append((start, end))
        self.bytes_read += len(b)
        return b


class Slab:
    """A fetched buffer plus its absolute file offset.

    Every offset a parser handles is absolute, so a slab can be swapped for a bigger one without
    rebasing arithmetic.
    """

    __slots__ = ("base", "data")

    def __init__(self, base, data):
        self.base = base
        self.data = data

    def __len__(self):
        return len(self.data)

    @property
    def end(self):
        return self.base + len(self.data)

    def covers(self, off, n=1):
        return off >= self.base and off + n <= self.end

    def u8(self, off):
        return self.data[off - self.base]

    def u16be(self, off):
        i = off - self.base
        d = self.data
        return (d[i] << 8) | d[i + 1]

    def u32be(self, off):
        i = off - self.base
        d = self.data
        return (d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]

    def u64be(self, off):
        return (self.u32be(off) << 32) | self.u32be(off + 4)

    def bytes(self, off, n):
        i = off - self.base
        return self.data[i : i + n]

    def find(self, needle, start, end=None):
        i = self.data.find(
            needle, start - self.base, (end - self.base) if end is not None else None
        )
        return -1 if i < 0 else i + self.base

    def rfind(self, needle, start, end=None):
        i = self.data.rfind(
            needle, start - self.base, (end - self.base) if end is not None else None
        )
        return -1 if i < 0 else i + self.base


def read_slab(reader, start, end):
    if start < 0:
        start = 0
    n = reader.size()
    if end > n:
        end = n
    if end < start:
        end = start
    return Slab(start, reader.read_range(start, end))


def scan_chunks(reader, chunk=4 * 1024 * 1024, overlap=4096, start=0, end=None):
    """Yield overlapping slabs across a range. spec/10-containers.md §10.3.

    Overlap is mandatory: records and NMEA sentences straddle chunk boundaries. Callers suppress
    duplicates by ignoring matches that begin before ``slab.base + overlap`` on any slab after the
    first (see ``dedupe_start``).
    """
    n = reader.size()
    if end is None or end > n:
        end = n
    pos = start
    first = True
    while pos < end:
        stop = pos + chunk
        if stop > end:
            stop = end
        yield Slab(pos, reader.read_range(pos, stop)), first
        if stop >= end:
            break
        pos = stop - overlap
        if pos <= 0:
            pos = stop
        first = False


def capped_windows(size, cap):
    """Byte ranges a full-scan format is allowed to read.

    The head, and - when the file is big enough that they do not overlap - the tail, because an
    appended metadata block lives at the end. Without this bound, one clip that matches nothing
    costs a whole pass over a gigabyte for every full-scan format in the registry.
    """
    if cap <= 0 or size <= cap:
        return [(0, size)]
    if size <= 2 * cap:
        return [(0, size)]
    return [(0, cap), (size - cap, size)]


def dedupe_start(slab, first, overlap):
    """Lowest absolute offset at which a match on this slab should be accepted."""
    return slab.base if first else slab.base + overlap

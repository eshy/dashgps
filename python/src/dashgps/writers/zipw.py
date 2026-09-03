"""Dependency-free stored-ZIP writer. spec/21-outputs.md.

Fixed DOS timestamp so archives are byte-reproducible and can be diffed by the parity gate.
No compression, no ZIP64 - an archive above 4 GiB is an error rather than a corrupt file.
"""

DOS_TIME = 0x0000  # 00:00:00
DOS_DATE = 0x0021  # 1980-01-01
MAX_SIZE = 0xFFFFFFFF

_CRC_TABLE = None


def _table():
    global _CRC_TABLE
    if _CRC_TABLE is None:
        t = []
        for i in range(256):
            c = i
            for _ in range(8):
                c = (c >> 1) ^ (0xEDB88320 & -(c & 1))
            t.append(c & 0xFFFFFFFF)
        _CRC_TABLE = t
    return _CRC_TABLE


def crc32(data):
    t = _table()
    c = 0xFFFFFFFF
    for b in data:
        c = t[(c ^ b) & 0xFF] ^ (c >> 8)
    return c ^ 0xFFFFFFFF


def _u16(v):
    return bytes(((v & 0xFF), ((v >> 8) & 0xFF)))


def _u32(v):
    return bytes(((v & 0xFF), ((v >> 8) & 0xFF), ((v >> 16) & 0xFF), ((v >> 24) & 0xFF)))


def build(members):
    """members: list of (name, bytes). Returns the whole archive."""
    parts = []
    central = []
    offset = 0
    for name, data in members:
        nb = name.encode("utf-8")
        c = crc32(data)
        n = len(data)
        if n > MAX_SIZE or offset > MAX_SIZE:
            raise ValueError("zip member or archive exceeds 4 GiB; ZIP64 is not supported")
        local = (
            b"PK\x03\x04" + _u16(20) + _u16(0) + _u16(0) + _u16(DOS_TIME) + _u16(DOS_DATE)
            + _u32(c) + _u32(n) + _u32(n) + _u16(len(nb)) + _u16(0) + nb
        )
        parts.append(local)
        parts.append(data)
        central.append(
            b"PK\x01\x02" + _u16(20) + _u16(20) + _u16(0) + _u16(0)
            + _u16(DOS_TIME) + _u16(DOS_DATE) + _u32(c) + _u32(n) + _u32(n)
            + _u16(len(nb)) + _u16(0) + _u16(0) + _u16(0) + _u16(0) + _u32(0)
            + _u32(offset) + nb
        )
        offset += len(local) + n
    cd = b"".join(central)
    eocd = (
        b"PK\x05\x06" + _u16(0) + _u16(0) + _u16(len(members)) + _u16(len(members))
        + _u32(len(cd)) + _u32(offset) + _u16(0)
    )
    return b"".join(parts) + cd + eocd

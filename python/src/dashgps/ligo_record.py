"""The LigoGPS ASCII record grammar, shared by ligo.ts_trailer and ligo.plain.

Implements spec/01-ligogps-ts-trailer.md §1.5-1.7. No regular expressions: the grammar is
positional and a hand-written tokenizer is both faster and easier to keep identical across the
two language cores.
"""

from .fmt import NAN, epoch_from_civil, parse_num

LIGO_MAGIC = b"LIGOGPSINFO"

STRIDE_MIN = 100
STRIDE_MAX = 1024
STRIDE_FALLBACKS = (132, 140)
STRIDE_SEARCH = 2048


def _is_digit(b):
    return 48 <= b <= 57


def is_date_shape(slab, off):
    """True if 'DDDD/DD/DD ' sits at off. spec 01 clause 5."""
    if not slab.covers(off, 11):
        return False
    d = slab.bytes(off, 11)
    if d[4] != 0x2F or d[7] != 0x2F or d[10] != 0x20:
        return False
    for i in (0, 1, 2, 3, 5, 6, 8, 9):
        if not _is_digit(d[i]):
            return False
    return True


def detect_stride(slab, first_rec, block_end):
    """Return (stride, warning). spec 01 clause 6.

    A wrong stride produces plausible-looking garbage, so this validates a third record before
    accepting a candidate and refuses rather than guessing when nothing validates.
    """
    off1 = first_rec + 4
    if not is_date_shape(slab, off1):
        return 0, "first record does not start with a date"

    limit = min(off1 + STRIDE_SEARCH, block_end)
    stride = STRIDE_MIN
    while stride <= STRIDE_MAX:
        p2 = off1 + stride
        if p2 + 11 > limit:
            break
        if is_date_shape(slab, p2):
            p3 = off1 + 2 * stride
            if p3 + 11 > block_end or is_date_shape(slab, p3):
                return stride, None
        stride += 4

    # Only one record in the block: nothing to difference. Fall back, but say so.
    for cand in STRIDE_FALLBACKS:
        if first_rec + cand > block_end:
            return cand, "single record; assuming stride %d" % cand
        if is_date_shape(slab, off1 + cand):
            return cand, "stride autodetect inconclusive; using %d" % cand
    if first_rec + STRIDE_FALLBACKS[0] >= block_end:
        return STRIDE_FALLBACKS[0], "single record; assuming stride %d" % STRIDE_FALLBACKS[0]
    return 0, "could not determine record stride"


def _coord(tok, pos_letter, neg_letter):
    """'N:25.774430' -> (+25.774430). Returns None if the token is not a coordinate."""
    if len(tok) < 3 or tok[1] != ":":
        return None
    h = tok[0]
    if h == pos_letter:
        sign = 1.0
    elif h == neg_letter:
        sign = -1.0
    else:
        return None
    v = parse_num(tok[2:])
    if v != v:
        return None
    return sign * v


def _date_parts(tok):
    if len(tok) != 10 or tok[4] != "/" or tok[7] != "/":
        return None
    try:
        y = int(tok[0:4])
        mo = int(tok[5:7])
        d = int(tok[8:10])
    except ValueError:
        return None
    if mo < 1 or mo > 12 or d < 1 or d > 31 or y < 1980 or y > 2200:
        return None
    return y, mo, d


def _time_parts(tok):
    if len(tok) != 8 or tok[2] != ":" or tok[5] != ":":
        return None
    try:
        h = int(tok[0:2])
        mi = int(tok[3:5])
        s = int(tok[6:8])
    except ValueError:
        return None
    if h > 23 or mi > 59 or s > 60:
        return None
    return h, mi, 59 if s == 60 else s


def split_tokens(text):
    """Split on single spaces, dropping empties. Deterministic in both languages."""
    return [t for t in text.split(" ") if t]


class LigoFields:
    __slots__ = ("t", "lat", "lon", "speed_kmh", "heading_deg", "alt_m", "magvar_deg",
                 "ax", "ay", "az", "nofix")

    def __init__(self):
        self.t = NAN
        self.lat = NAN
        self.lon = NAN
        self.speed_kmh = NAN
        self.heading_deg = NAN
        self.alt_m = NAN
        self.magvar_deg = NAN
        self.ax = NAN
        self.ay = NAN
        self.az = NAN
        self.nofix = False


def parse_ligo_text(text):
    """Parse one record body. Returns LigoFields, or None if it is not this grammar.

    spec 01 §1.5. Tokens 0-5 are positional; anything after is dispatched on its prefix, so
    firmware that omits A/H/M or reorders the trailing fields still parses.
    """
    toks = split_tokens(text)
    if len(toks) < 6:
        return None
    dp = _date_parts(toks[0])
    tp = _time_parts(toks[1])
    if dp is None or tp is None:
        return None
    lat = _coord(toks[2], "N", "S")
    lon = _coord(toks[3], "E", "W")
    if lat is None or lon is None:
        return None
    if toks[5] != "km/h":
        return None

    f = LigoFields()
    f.t = epoch_from_civil(dp[0], dp[1], dp[2], tp[0], tp[1], tp[2])
    f.lat = lat
    f.lon = lon
    f.speed_kmh = parse_num(toks[4])
    for tok in toks[6:]:
        if len(tok) < 3 or tok[1] != ":":
            continue
        k = tok[0]
        v = parse_num(tok[2:])
        if k == "x":
            f.ax = v
        elif k == "y":
            f.ay = v
        elif k == "z":
            f.az = v
        elif k == "A":
            f.heading_deg = v
        elif k == "H":
            f.alt_m = v
        elif k == "M":
            f.magvar_deg = v
    # A receiver with no fix writes literal zeros rather than omitting the record. spec 01 §1.5.
    if lat == 0.0 and lon == 0.0:
        f.nofix = True
    return f


def record_text(slab, rec_off, stride, index_prefix=4):
    """ASCII body of one record: from +index_prefix up to the first NUL."""
    body_len = stride - index_prefix
    if not slab.covers(rec_off + index_prefix, 1):
        return ""
    avail = slab.end - (rec_off + index_prefix)
    if body_len > avail:
        body_len = avail
    if body_len <= 0:
        return ""
    raw = slab.bytes(rec_off + index_prefix, body_len)
    z = raw.find(b"\x00")
    if z >= 0:
        raw = raw[:z]
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError:
        return raw.decode("ascii", "replace")


def is_ascii_region(slab, off, n):
    """Printable ASCII or NUL. spec 01 clause 5."""
    if not slab.covers(off, 1):
        return False
    avail = slab.end - off
    if n > avail:
        n = avail
    if n <= 0:
        return False
    for b in slab.bytes(off, n):
        if b != 0 and (b < 0x20 or b > 0x7E):
            return False
    return True

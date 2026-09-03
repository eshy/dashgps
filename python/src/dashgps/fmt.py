"""Deterministic formatting primitives.

Implements spec/30-formatting.md. Every function here has a byte-identical twin in js/src/fmt.js.

Do not use str.format, %-formatting, f-string precision, round(), datetime, or json.dumps
anywhere in this module or in anything that produces output. See spec/30-formatting.md for why.
"""

import math

NAN = float("nan")

# Exactly-representable powers of ten, as a table rather than 10**n, so that Python and
# JavaScript multiply by bit-identical constants. spec 30.1.
_POW10 = (
    1.0, 10.0, 100.0, 1000.0, 10000.0, 100000.0,
    1000000.0, 10000000.0, 100000000.0, 1000000000.0,
)

_MAX_EXACT = 9007199254740992.0  # 2**53

# Field precisions, locked by spec 30.1.
P_LATLON = 6
P_ALT = 1
P_SPEED = 2
P_ANGLE = 1
P_ACCEL = 3
P_DT = 3
P_DIST = 3
P_DUR = 3

EARTH_R_M = 6371008.8  # IUGG mean radius, spec 20.4


def is_nan(x):
    return x is None or x != x


def fixed(x, n):
    """Format with exactly n decimals, half-up, never exponent. spec 30.1."""
    if x is None or x != x:  # None or NaN
        return ""
    if x == math.inf or x == -math.inf:
        return ""
    neg = x < 0.0
    y = (-x if neg else x) * _POW10[n]
    if y >= _MAX_EXACT:
        return ""
    i = int(y)  # y >= 0, so truncation is floor
    if (y - i) >= 0.5:
        i += 1
    s = str(i)
    if n > 0:
        if len(s) < n + 1:
            s = "0" * (n + 1 - len(s)) + s
        s = s[: len(s) - n] + "." + s[len(s) - n :]
    if neg:
        for ch in s:
            if ch != "0" and ch != ".":
                return "-" + s
    return s


def zpad(v, width):
    s = str(v)
    if len(s) < width:
        s = "0" * (width - len(s)) + s
    return s


def days_from_civil(y, m, d):
    """Days since 1970-01-01, proleptic Gregorian. Hinnant. spec 30.2."""
    y -= 1 if m <= 2 else 0
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def civil_from_days(z):
    """Inverse of days_from_civil. spec 30.2."""
    z += 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return (y + (1 if m <= 2 else 0), m, d)


def epoch_from_civil(y, mo, d, h, mi, s):
    return float(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s)


def iso_local(t):
    """'YYYY-MM-DDTHH:MM:SS' with no zone designator. spec 30.2."""
    if t is None or t != t:
        return ""
    days = math.floor(t / 86400.0)
    secs = int(math.floor(t - days * 86400.0))
    if secs < 0:
        secs = 0
    elif secs > 86399:
        secs = 86399
    y, mo, d = civil_from_days(int(days))
    return (
        zpad(y, 4) + "-" + zpad(mo, 2) + "-" + zpad(d, 2) + "T"
        + zpad(secs // 3600, 2) + ":" + zpad((secs // 60) % 60, 2) + ":" + zpad(secs % 60, 2)
    )


def iso_z(t):
    s = iso_local(t)
    return s + "Z" if s else ""


def date_local(t):
    s = iso_local(t)
    return s[:10] if s else ""


_JSON_ESC = {
    0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0C: "\\f", 0x0D: "\\r",
    0x22: '\\"', 0x5C: "\\\\",
}


def json_str(s):
    """Minimal JSON string escaper with a fixed escape set. spec 30.3."""
    out = ['"']
    for ch in s:
        c = ord(ch)
        e = _JSON_ESC.get(c)
        if e is not None:
            out.append(e)
        elif c < 0x20:
            out.append("\\u" + zpad_hex(c))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def zpad_hex(c):
    h = "0123456789abcdef"
    return h[(c >> 12) & 15] + h[(c >> 8) & 15] + h[(c >> 4) & 15] + h[c & 15]


def byte_key(s):
    """Sort key: raw UTF-8 bytes, so ordering matches JavaScript's. spec 30.4."""
    return s.encode("utf-8")


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres. spec 20.4."""
    rad = math.pi / 180.0
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlon / 2.0) ** 2
    )
    if a < 0.0:
        a = 0.0
    elif a > 1.0:
        a = 1.0
    return 2.0 * EARTH_R_M * math.asin(math.sqrt(a))


_NUM_OK = "0123456789"


def parse_num(tok):
    """Validate then convert. Returns NaN on anything malformed. spec 01 §1.7."""
    if not tok:
        return NAN
    i = 0
    n = len(tok)
    if tok[0] == "-" or tok[0] == "+":
        i = 1
    digits = 0
    dot = 0
    while i < n:
        c = tok[i]
        if c in _NUM_OK:
            digits += 1
        elif c == ".":
            dot += 1
            if dot > 1:
                return NAN
        else:
            return NAN
        i += 1
    if digits == 0:
        return NAN
    try:
        return float(tok)
    except ValueError:
        return NAN


def csv_cell(v):
    """Minimal RFC 4180 quoting. spec 21."""
    if ("," in v) or ('"' in v) or ("\n" in v) or ("\r" in v):
        return '"' + v.replace('"', '""') + '"'
    return v


def xml_text(s):
    return (
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def json_value(v, indent=0):
    """Tiny deterministic JSON emitter for metadata. Dict order is insertion order, matching
    JavaScript object semantics for string keys. spec 30.3."""
    pad = "  " * indent
    pad2 = "  " * (indent + 1)
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return json_str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v or v == math.inf or v == -math.inf:
            return "null"
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return fixed(v, 6)
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        items = [pad2 + json_value(x, indent + 1) for x in v]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = [pad2 + json_str(str(k)) + ": " + json_value(x, indent + 1) for k, x in v.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    return json_str(str(v))

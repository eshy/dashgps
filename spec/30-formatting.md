# 30 — Deterministic formatting

Every dashgps implementation must produce **byte-identical** output for identical input. This
document is the contract that makes that possible. It is normative: the Python and JavaScript
cores transcribe the algorithms below literally, and CI diffs their output.

The rule that everything else follows from:

> **Never use a language's built-in number formatter, date formatter, JSON serializer, or default
> sort.** They differ across languages, versions and locales.

CI greps the core source trees and fails on `toFixed(`, `toPrecision(`, `JSON.stringify(`,
`json.dumps(`, `datetime.`, `strftime`, `new Date(`, `Date.now(`, `round(`, `%f`, `f"{...:.Nf}"`.
Additions to the allowlist require a comment explaining why they are safe.

---

## 30.1 `fixed(x, n) -> string`

Formats a float with exactly `n` digits after the decimal point, half-up, no exponent.

```
fixed(x, n):
    if x is NaN or x is None:        return ""          # empty cell, not "NaN"
    if x is +Inf or x is -Inf:       return ""
    neg = (x < 0)
    y   = abs(x) * 10^n                                 # IEEE-754 double multiply
    if y >= 9007199254740992:        return ""          # 2^53; out of exact-integer range
    i   = floor(y)                                      # exact for y < 2^53
    if (y - i) >= 0.5: i = i + 1                        # HALF-UP, never banker's rounding
    s   = decimal_digits(i)                             # no separators, no exponent
    if n > 0:
        s = pad_left(s, n + 1, '0')
        s = s[0 : len(s)-n] + "." + s[len(s)-n :]
    if neg and s contains a nonzero digit:
        s = "-" + s
    return s
```

Notes:

- `10^n` is a lookup into a constant table `[1, 10, 100, ..., 1e9]`, not `Math.pow`/`**`, so both
  languages use the identical exactly-representable constant.
- The `neg and s contains a nonzero digit` guard normalises `-0.0000001` to `"0.000000"` rather
  than `"-0.000000"`. Signed zero must never reach the output.
- The `2^53` guard means an absurd coordinate produces an empty cell rather than `1e+21`.
  JavaScript's `String(1e21)` would otherwise emit exponent notation and break parity.

### Field precisions

These are locked. Changing one is a breaking output change.

| Field | Digits |
|---|---|
| `lat`, `lon` | 6 |
| `alt_m` | 1 |
| `speed_kmh` | 2 |
| `heading_deg`, `magvar_deg` | 1 |
| `accel_x`, `accel_y`, `accel_z` | 3 |
| `dt_s` | 3 |
| `distance_km` | 3 |
| `duration_s` | 3 |

Six decimal places of latitude is ~11 cm — well below GPS noise, and the precision the source
records already carry.

---

## 30.2 Time

Timestamps are held as a float count of seconds from the Unix epoch. **They are naive**: the
LigoGPS record grammar carries no timezone, so the value is the camera's wall clock reinterpreted
as if it were UTC. `time_is_naive: true` rides in the summary output, and `--tz-offset` subtracts
a known offset to make it truly UTC. dashgps never guesses the zone.

Civil-date conversion uses Howard Hinnant's integer algorithms — no library date type.

```
days_from_civil(y, m, d):                 # proleptic Gregorian, returns days from 1970-01-01
    y = y - (m <= 2)
    era = floor(y / 400)
    yoe = y - era * 400                                     # [0, 399]
    doy = floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
    doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy
    return era * 146097 + doe - 719468

civil_from_days(z):
    z   = z + 719468
    era = floor(z / 146097)
    doe = z - era * 146097                                  # [0, 146096]
    yoe = floor((doe - floor(doe/1460) + floor(doe/36524) - floor(doe/146096)) / 365)
    y   = yoe + era * 400
    doy = doe - (365 * yoe + floor(yoe/4) - floor(yoe/100))
    mp  = floor((5 * doy + 2) / 153)
    d   = doy - floor((153 * mp + 2) / 5) + 1
    m   = mp + (mp < 10 ? 3 : -9)
    return (y + (m <= 2), m, d)
```

All divisions are **floor** division on integers. JavaScript must use `Math.floor(a / b)`, never
`a / b | 0` (which truncates toward zero and breaks on negatives, i.e. dates before 1970).

```
iso_local(t):                             # "YYYY-MM-DDTHH:MM:SS"  — CSV
    days = floor(t / 86400)
    secs = floor(t - days * 86400)                          # [0, 86399]
    (y, m, d) = civil_from_days(days)
    return zpad(y,4) "-" zpad(m,2) "-" zpad(d,2) "T"
           zpad(floor(secs/3600),2) ":" zpad(floor(secs/60) % 60,2) ":" zpad(secs % 60,2)

iso_z(t):    return iso_local(t) + "Z"    # GPX, which requires a zone designator
```

Sub-second components are truncated, not rounded: every source format in v1 is whole-second.

**GPX caveat.** GPX 1.1 requires `<time>` to be UTC. When the input is naive we still emit `Z`,
because omitting time entirely is worse for consumers, and every other dashcam tool does the same.
The GPX header carries an XML comment saying so, and `--tz-offset` makes it truthful.

---

## 30.3 JSON

Hand-rolled emitter. Keys are written in the order given by the writer — never sorted, never
insertion-ordered by a hash map. Indent is two spaces. No trailing whitespace. Files end with
exactly one `\n`.

```
json_string(s):
    out = '"'
    for each Unicode code point c in s:
        if c == '"':  out += '\"'
        elif c == '\\': out += '\\\\'
        elif c == 0x08: out += '\b'
        elif c == 0x0C: out += '\f'
        elif c == 0x0A: out += '\n'
        elif c == 0x0D: out += '\r'
        elif c == 0x09: out += '\t'
        elif c < 0x20:  out += '\u' + lowercase_hex4(c)
        else: out += c                                      # UTF-8 on the wire, not escaped
    return out + '"'
```

Numbers in JSON output go through `fixed()` at the precision for their field, then are emitted
bare. Integers are emitted via `decimal_digits`. `null` is used for a genuinely absent value;
`fixed()`'s empty string is a CSV convention and must not leak into JSON.

---

## 30.4 Ordering

All ordering — files within a group, groups within a run, keys in a listing — uses a **byte-wise**
comparison of the UTF-8 encoding, never a locale collation.

```
byte_key(s): UTF-8 bytes of s
compare(a, b): lexicographic unsigned-byte comparison, shorter is smaller on a prefix tie
```

Python's default `str` comparison is by code point, and JavaScript's is by UTF-16 code unit; those
differ for characters above U+FFFF. Both cores therefore compare explicit byte arrays.

Points are sorted stably by `(t, src, idx)` where `src` is the index of the source file in the
byte-sorted source list and `idx` is the record index within that file. This makes the order total
and independent of the order files were handed to the tool — which matters because the browser
parses files in parallel and they complete out of order.

---

## 30.5 Line endings and encoding

- Output is UTF-8 with no BOM.
- Line terminator is `\n` everywhere, including CSV. (RFC 4180 asks for `\r\n`; every consumer
  accepts `\n`, and mixing terminators across platforms would break parity.) Python file handles
  are opened with `newline=""` so the runtime does not translate.
- Every text output ends with exactly one trailing `\n`.

---

## 30.6 The one known parity risk

`distance_km` derives from a haversine, which calls `sin`/`cos`/`asin` from each platform's libm.
Those are not guaranteed bit-identical across platforms or languages. Rounding to 3 decimals
(metre precision) means divergence requires a value landing within about 1 ulp of a `x.xxx5` tie —
vanishingly unlikely, but not provable.

The earth radius is fixed at `R = 6371008.8` m (IUGG mean radius).

If CI ever flags this, the mitigation is specified but deliberately not implemented yet: replace
the haversine with an equirectangular approximation whose `cos` comes from a 256-entry table over
0–90° with linear interpolation. That is fully deterministic and its error (~0.3 % over a 1-second
GPS step) is far below GPS noise. Implement it only if the risk materialises.

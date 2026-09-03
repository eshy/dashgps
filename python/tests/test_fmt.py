"""Unit tests for the deterministic formatting layer. spec/30-formatting.md.

These same vectors are asserted by js/test/fmt.test.js. If the two ever disagree, output parity
is already broken and the golden tests will only tell you afterwards.
"""

import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "python", "src"))

from dashgps import fmt  # noqa: E402

FIXED_VECTORS = [
    (0.0, 6, "0.000000"),
    (-0.0, 6, "0.000000"),
    (25.774430, 6, "25.774430"),
    (-80.137840, 6, "-80.137840"),
    (1.0, 0, "1"),
    (0.5, 0, "1"),          # half-up, not banker's
    (1.5, 0, "2"),
    (2.5, 0, "3"),          # banker's rounding would give 2
    (-0.5, 0, "-1"),
    (-1.5, 0, "-2"),
    (0.0000001, 6, "0.000000"),
    (-0.0000001, 6, "0.000000"),   # signed zero must never reach the output
    (-0.0000005, 6, "-0.000001"),
    (123.456, 2, "123.46"),
    (123.454, 2, "123.45"),
    (1e15, 3, ""),          # beyond exact-integer range -> empty, never exponent notation
    (float("inf"), 2, ""),
    (float("-inf"), 2, ""),
    (float("nan"), 2, ""),
    (None, 2, ""),
    (9.999, 2, "10.00"),
    (-9.999, 2, "-10.00"),
    (0.001, 3, "0.001"),
    (-0.0004, 3, "0.000"),
]

CIVIL_VECTORS = [
    (1970, 1, 1, 0),
    (1969, 12, 31, -1),
    (2000, 3, 1, 11017),
    (2026, 8, 3, 20668),
    (1900, 1, 1, -25567),
    (2200, 12, 31, 84370),
]

ISO_VECTORS = [
    (0.0, "1970-01-01T00:00:00"),
    (1785750858.0, "2026-08-03T09:54:18"),
    (-1.0, "1969-12-31T23:59:59"),
    (86399.0, "1970-01-01T23:59:59"),
]


class TestFixed(unittest.TestCase):
    def test_vectors(self):
        for value, digits, want in FIXED_VECTORS:
            self.assertEqual(fmt.fixed(value, digits), want,
                             "fixed(%r, %d)" % (value, digits))

    def test_never_emits_exponent(self):
        for v in (1e14, 1e-12, 12345678.9):
            for n in range(0, 7):
                self.assertNotIn("e", fmt.fixed(v, n).lower())

    def test_digit_count_is_exact(self):
        for n in range(0, 8):
            s = fmt.fixed(1.23456789, n)
            if n == 0:
                self.assertEqual(s, "1")
            else:
                self.assertEqual(len(s.split(".")[1]), n)


class TestCivil(unittest.TestCase):
    def test_days_from_civil(self):
        for y, m, d, want in CIVIL_VECTORS:
            self.assertEqual(fmt.days_from_civil(y, m, d), want, "%d-%d-%d" % (y, m, d))

    def test_roundtrip(self):
        for z in range(-30000, 90000, 97):
            y, m, d = fmt.civil_from_days(z)
            self.assertEqual(fmt.days_from_civil(y, m, d), z)

    def test_iso(self):
        for t, want in ISO_VECTORS:
            self.assertEqual(fmt.iso_local(t), want)

    def test_iso_z_and_date(self):
        self.assertEqual(fmt.iso_z(1785750858.0), "2026-08-03T09:54:18Z")
        self.assertEqual(fmt.date_local(1785750858.0), "2026-08-03")


class TestParseNum(unittest.TestCase):
    def test_valid(self):
        for tok, want in (("1", 1.0), ("-2.5", -2.5), ("+3", 3.0), ("0.000001", 0.000001),
                          ("080.137840", 80.13784)):
            self.assertEqual(fmt.parse_num(tok), want)

    def test_invalid_is_nan(self):
        for tok in ("", "abc", "1.2.3", "1e5", "--1", "1,5", " 1"):
            self.assertTrue(math.isnan(fmt.parse_num(tok)), tok)


class TestJson(unittest.TestCase):
    def test_escapes(self):
        self.assertEqual(fmt.json_str('a"b\\c'), '"a\\"b\\\\c"')
        self.assertEqual(fmt.json_str("tab\there"), '"tab\\there"')
        self.assertEqual(fmt.json_str("\x01"), '"\\u0001"')
        self.assertEqual(fmt.json_str("café"), '"café"')  # UTF-8, not escaped

    def test_value_key_order_is_insertion_order(self):
        out = fmt.json_value({"b": 1, "a": 2})
        self.assertLess(out.index('"b"'), out.index('"a"'))


class TestCsvQuoting(unittest.TestCase):
    def test_minimal(self):
        self.assertEqual(fmt.csv_cell("plain"), "plain")
        self.assertEqual(fmt.csv_cell("a,b"), '"a,b"')
        self.assertEqual(fmt.csv_cell('say "hi"'), '"say ""hi"""')


class TestByteKey(unittest.TestCase):
    def test_sorts_by_utf8_bytes(self):
        names = ["b.ts", "A.ts", "a.ts", "é.ts", "\U0001f600.ts"]
        got = sorted(names, key=fmt.byte_key)
        self.assertEqual(got[0], "A.ts")
        # Above the BMP, UTF-8 byte order and UTF-16 code-unit order disagree; sorting on bytes
        # is what keeps Python and JavaScript in step.
        self.assertEqual(got[-1], "\U0001f600.ts")


class TestHaversine(unittest.TestCase):
    def test_known_distance(self):
        # One degree of latitude at the equator.
        d = fmt.haversine_m(0.0, 0.0, 1.0, 0.0)
        self.assertAlmostEqual(d, 111194.9, delta=1.0)

    def test_zero(self):
        self.assertEqual(fmt.haversine_m(25.5, -80.1, 25.5, -80.1), 0.0)


if __name__ == "__main__":
    unittest.main()

"""Golden tests. spec/40-fixtures.md.

Both language suites enumerate fixtures/cases/*.json, so adding a case adds tests to Python and
JavaScript at once. Each case asserts:

  * the declared expectations (format id, point count, stride, outliers)
  * byte-exact equality with every golden artifact
  * the exact IO trace, which is what keeps "dashgps only reads the tail" a tested property
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "python", "src"))

from dashgps import (  # noqa: E402
    BytesReader,
    CountingReader,
    ParseOptions,
    cli,  # noqa: E402
    parse_auto,
)
from dashgps.model import NoFormatMatch, ParseError  # noqa: E402

CASES_DIR = os.path.join(ROOT, "fixtures", "cases")
BIN_DIR = os.path.join(ROOT, "fixtures", "bin")
GOLDEN_DIR = os.path.join(ROOT, "fixtures", "golden")

TAIL_SNIFF_BUDGET = 65536
HEAD_SNIFF_BUDGET = 256 * 1024


def load_cases():
    out = []
    for name in sorted(os.listdir(CASES_DIR)):
        if name.endswith(".json"):
            with open(os.path.join(CASES_DIR, name)) as f:
                out.append(json.load(f))
    return out


CASES = load_cases()


class TestCompleteness(unittest.TestCase):
    """A silently skipped case must fail the suite, not vanish."""

    def test_cases_exist(self):
        self.assertGreater(len(CASES), 0, "no fixture cases found")

    def test_every_case_has_a_binary(self):
        for c in CASES:
            self.assertTrue(
                os.path.exists(os.path.join(BIN_DIR, c["output"])),
                "missing fixture binary for case %s; run fixtures/build_fixtures.py" % c["id"],
            )

    def test_every_case_has_a_golden(self):
        for c in CASES:
            self.assertTrue(
                os.path.isdir(os.path.join(GOLDEN_DIR, c["id"])),
                "missing golden for case %s; run scripts/regen_golden.sh" % c["id"],
            )

    def test_every_golden_has_a_case(self):
        ids = set(c["id"] for c in CASES)
        for name in os.listdir(GOLDEN_DIR):
            if os.path.isdir(os.path.join(GOLDEN_DIR, name)):
                self.assertIn(name, ids, "golden %s has no case descriptor" % name)

    def test_manifest_matches(self):
        import hashlib

        with open(os.path.join(ROOT, "fixtures", "manifest.json")) as f:
            manifest = json.load(f)
        for c in CASES:
            with open(os.path.join(BIN_DIR, c["output"]), "rb") as f:
                data = f.read()
            entry = manifest[c["output"]]
            self.assertEqual(entry["size"], len(data), c["output"])
            self.assertEqual(entry["sha256"], hashlib.sha256(data).hexdigest(), c["output"])


class TestGoldens(unittest.TestCase):
    maxDiff = 4000


def _make_expect_test(case):
    def test(self):
        path = os.path.join(BIN_DIR, case["output"])
        with open(path, "rb") as f:
            reader = CountingReader(BytesReader(f.read(), case["output"]))
        exp = case["expect"]
        try:
            res = parse_auto(reader, ParseOptions())
        except (NoFormatMatch, ParseError):
            res = None
        if exp["format"] is None:
            self.assertIsNone(res, "expected no format to match %s" % case["output"])
            return
        self.assertIsNotNone(res, "expected %s to parse as %s" % (case["output"], exp["format"]))
        self.assertEqual(res.format_id, exp["format"])
        self.assertEqual(len(res.points), exp["points"])
        if "stride" in exp:
            self.assertEqual(res.meta.get("stride"), exp["stride"])

    return test


def _make_golden_test(case):
    def test(self):
        golden = os.path.join(GOLDEN_DIR, case["id"])
        tmp = tempfile.mkdtemp(prefix="dashgps-test-")
        try:
            rc = cli.main([
                "extract", os.path.join(BIN_DIR, case["output"]),
                "-o", tmp, "--group", "none", "--meta", "-q",
            ])
            self.assertIn(rc, (0, 1))
            want = sorted(os.listdir(golden))
            got = sorted(os.listdir(tmp))
            self.assertEqual(want, got, "output file set differs for %s" % case["id"])
            for name in want:
                with open(os.path.join(golden, name), "rb") as f:
                    a = f.read()
                with open(os.path.join(tmp, name), "rb") as f:
                    b = f.read()
                if a != b:
                    self.fail(
                        "%s/%s differs from the golden.\n--- golden\n%s\n--- got\n%s"
                        % (case["id"], name,
                           a.decode("utf-8", "replace")[:1500],
                           b.decode("utf-8", "replace")[:1500])
                    )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    return test


def _make_io_test(case):
    def test(self):
        with open(os.path.join(GOLDEN_DIR, case["id"], "meta.json")) as f:
            meta = json.load(f)
        entry = meta["files"][0]
        path = os.path.join(BIN_DIR, case["output"])
        with open(path, "rb") as f:
            reader = CountingReader(BytesReader(f.read(), case["output"]))
        try:
            parse_auto(reader, ParseOptions())
        except (NoFormatMatch, ParseError):
            pass
        self.assertEqual(
            [list(r) for r in reader.ranges], entry["read_ranges"],
            "IO trace changed for %s; if that is intended, regenerate the goldens" % case["id"],
        )
        self.assertEqual(reader.bytes_read, entry["bytes_read"])

    return test


for _c in CASES:
    setattr(TestGoldens, "test_expect_" + _c["id"], _make_expect_test(_c))
    setattr(TestGoldens, "test_golden_" + _c["id"], _make_golden_test(_c))
    setattr(TestGoldens, "test_io_" + _c["id"], _make_io_test(_c))


class TestSniffBudgets(unittest.TestCase):
    """A format that lies about its IO cost breaks the performance promise for everybody."""

    def test_tail_and_head_sniffs_stay_in_budget(self):
        from dashgps.registry import formats

        for case in CASES:
            path = os.path.join(BIN_DIR, case["output"])
            with open(path, "rb") as f:
                data = f.read()
            for spec in formats():
                if spec.cost == "full-scan":
                    continue
                budget = TAIL_SNIFF_BUDGET if spec.cost == "tail" else HEAD_SNIFF_BUDGET
                reader = CountingReader(BytesReader(data, case["output"]))
                try:
                    spec.sniff(reader, ParseOptions())
                except Exception:
                    pass
                self.assertLessEqual(
                    reader.bytes_read, budget,
                    "%s sniff read %d bytes of %s, over its %s budget of %d"
                    % (spec.id, reader.bytes_read, case["output"], spec.cost, budget),
                )

    def test_tail_format_reads_a_fraction_of_a_large_file(self):
        """The headline claim: a 1 GB clip costs kilobytes, not gigabytes."""
        path = os.path.join(BIN_DIR, "ligo_ts_trailer_large.ts")
        with open(path, "rb") as f:
            data = f.read()
        reader = CountingReader(BytesReader(data, "large"))
        res = parse_auto(reader, ParseOptions())
        self.assertEqual(res.format_id, "ligo.ts_trailer")
        self.assertLess(
            reader.bytes_read, len(data) // 10,
            "parsing read %d of %d bytes; the tail-only read strategy has regressed"
            % (reader.bytes_read, len(data)),
        )


if __name__ == "__main__":
    unittest.main()

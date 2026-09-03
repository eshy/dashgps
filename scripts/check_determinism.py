#!/usr/bin/env python3
"""Guard the output-parity contract at the point a violation is introduced.

Built-in number, date and JSON formatters differ between Python and JavaScript, so
spec/30-formatting.md bans them from the two cores. Without this check a violation surfaces weeks
later as an unexplained golden diff on somebody else's platform.

A line may opt out with a trailing `deterministic-ok: <reason>` comment.

Usage:  python3 scripts/check_determinism.py [--self-test]
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TREES = ("python/src/dashgps", "js/src")

BANNED = [
    (r"\.toFixed\s*\(", "toFixed rounds half-to-even on ties; use fmt.fixed"),
    (r"\.toPrecision\s*\(", "toPrecision can emit exponent notation; use fmt.fixed"),
    (r"\bJSON\.stringify\s*\(", "key order and number formatting are not portable; use jsonValue"),
    (r"\bjson\.dumps\s*\(", "key order and number formatting are not portable; use json_value"),
    (r"\bdatetime\b", "date libraries disagree on edge cases; use fmt.iso_local"),
    (r"\bstrftime\b", "locale-dependent; use fmt.iso_local"),
    (r"\bnew\s+Date\s*\(", "date libraries disagree on edge cases; use fmt.isoLocal"),
    (r"\bDate\.now\s*\(", "non-deterministic; output must not depend on the clock"),
    (r"\bMath\.round\s*\(", "rounds .5 toward +Infinity, unlike Python; use fmt.fixed"),
    (r"(?<![\w.])round\s*\(", "Python's round is banker's rounding; use fmt.fixed"),
    (r"%\.\d+f", "printf float formatting is not guaranteed identical; use fmt.fixed"),
    (r"\{[^{}]*:\.\d+f\}", "f-string precision is not guaranteed identical; use fmt.fixed"),
    (r"\.sort\s*\(\s*\)", "default sort is by code unit in JS and code point in Python; "
                          "pass an explicit comparator"),
]

ALLOW = "deterministic-ok"


def sources():
    out = []
    for tree in TREES:
        for root, dirs, files in os.walk(os.path.join(ROOT, tree)):
            dirs[:] = sorted(d for d in dirs if d != "__pycache__")
            for name in sorted(files):
                if name.endswith((".py", ".js")):
                    out.append(os.path.join(root, name))
    return out


PY_QUOTES = ('"' * 3, "'" * 3)


def code_lines(path):
    """Yield (lineno, line) for lines that are actual code.

    Docstrings and block comments are prose. They routinely name the very constructs we ban, and
    flagging a sentence that says "do not use round()" would train people to ignore this tool.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()
    is_py = path.endswith(".py")
    in_doc = None      # the triple-quote delimiter we are inside (Python)
    in_block = False   # /* ... */ (JavaScript)
    for lineno, line in enumerate(text.split("\n"), 1):
        stripped = line.strip()
        if is_py:
            if in_doc is not None:
                if in_doc in line:
                    in_doc = None
                continue
            opener = None
            for q in PY_QUOTES:
                if stripped.startswith(q):
                    opener = q
                    break
            if opener is not None:
                if stripped.count(opener) == 1:
                    in_doc = opener
                continue
            if stripped.startswith("#"):
                continue
            yield lineno, line
            continue
        if in_block:
            if "*/" in line:
                in_block = False
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block = True
            continue
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        yield lineno, line


def scan(paths):
    problems = []
    for path in paths:
        for lineno, line in code_lines(path):
            if ALLOW in line:
                continue
            for pattern, why in BANNED:
                if re.search(pattern, line):
                    problems.append((os.path.relpath(path, ROOT), lineno, line.strip(), why))
    return problems


def self_test():
    """Prove the guard actually fires - a green check that cannot fail is worthless."""
    import tempfile

    bad = [
        "x = round(1.5)",
        "y = value.toFixed(2)",
        'z = JSON.stringify(obj)',
        "names.sort()",
        's = "%.3f" % v',
    ]
    ok = 0
    for snippet in bad:
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(snippet + "\n")
            tmp = f.name
        found = scan([tmp])
        os.unlink(tmp)
        if found:
            ok += 1
        else:
            sys.stderr.write("self-test FAILED: guard did not catch %r\n" % snippet)
    good = "s = fixed(v, 3)  # the approved path\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(good)
        tmp = f.name
    if scan([tmp]):
        sys.stderr.write("self-test FAILED: guard fired on approved code\n")
        os.unlink(tmp)
        return 1
    os.unlink(tmp)
    if ok != len(bad):
        return 1
    sys.stdout.write("self-test: guard catches %d/%d violations and passes clean code\n"
                     % (ok, len(bad)))
    return 0


def main(argv):
    if "--self-test" in argv:
        rc = self_test()
        if rc:
            return rc
    paths = sources()
    problems = scan(paths)
    for rel, lineno, line, why in problems:
        sys.stdout.write("%s:%d\n    %s\n    ^ %s\n" % (rel, lineno, line, why))
    if problems:
        sys.stderr.write(
            "\n%d banned construct(s) in the core. These differ between Python and JavaScript "
            "and would break output parity.\nUse the helpers in fmt, or add a "
            "'deterministic-ok: <reason>' comment on the line.\n" % len(problems)
        )
        return 1
    sys.stdout.write("determinism guard: clean (%d core files)\n" % len(paths))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

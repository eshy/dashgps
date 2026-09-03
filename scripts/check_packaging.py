#!/usr/bin/env python3
"""Check that every file the package manifests promise actually exists.

This exists because it already bit us: `python/pyproject.toml` declared `readme = "README.md"`
while the only README lived at the repo root, so `python -m build` would have failed — and the
first time anyone would have found out was a tagged release.

Deliberately dependency-free, and deliberately not a substitute for actually building: CI does
that too. This just fails fast, on every push, without needing a network.

Usage:  python3 scripts/check_packaging.py [--self-test]
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def toml_str(text, key, table=None):
    """Pull a single quoted scalar out of a TOML file without a TOML parser.

    Only handles what this project's pyproject actually uses; anything more and we would take the
    tomllib dependency and lose Python 3.9.
    """
    body = text
    if table is not None:
        m = re.search(r"^\[" + re.escape(table) + r"\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
        if not m:
            return None
        body = m.group(1)
    m = re.search(r'^\s*' + re.escape(key) + r'\s*=\s*"([^"]+)"', body, re.M)
    return m.group(1) if m else None


def toml_list(text, key, table=None):
    body = text
    if table is not None:
        m = re.search(r"^\[" + re.escape(table) + r"\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
        if not m:
            return []
        body = m.group(1)
    m = re.search(r'^\s*' + re.escape(key) + r'\s*=\s*\[(.*?)\]', body, re.M | re.S)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def check_python(problems):
    rel = "python/pyproject.toml"
    text = read(rel)
    base = "python"

    readme = toml_str(text, "readme", "project")
    if not readme:
        problems.append((rel, "no `readme` declared"))
    elif not os.path.exists(os.path.join(ROOT, base, readme)):
        problems.append((rel, "readme = %r but %s/%s does not exist" % (readme, base, readme)))

    for pkg in toml_list(text, "packages", "tool.hatch.build.targets.wheel"):
        if not os.path.isdir(os.path.join(ROOT, base, pkg)):
            problems.append((rel, "wheel packages names %s/%s, which is not a directory"
                             % (base, pkg)))

    script = toml_str(text, "dashgps", "project.scripts")
    if script:
        mod = script.split(":")[0].replace(".", "/") + ".py"
        if not os.path.exists(os.path.join(ROOT, base, "src", mod)):
            problems.append((rel, "console script points at %s, which does not exist" % script))

    # Not fatal, but a wheel with no licence file is a packaging smell.
    if not os.path.exists(os.path.join(ROOT, base, "LICENSE")):
        problems.append((rel, "no python/LICENSE; the wheel would ship without a licence file"))


def check_js(problems):
    rel = "js/package.json"
    pkg = json.loads(read(rel))
    base = "js"

    for name in pkg.get("files", []):
        if not os.path.exists(os.path.join(ROOT, base, name)):
            problems.append((rel, '"files" lists %s, which does not exist' % name))

    for name, target in (pkg.get("bin") or {}).items():
        if not os.path.exists(os.path.join(ROOT, base, target)):
            problems.append((rel, 'bin "%s" points at %s, which does not exist' % (name, target)))

    main = pkg.get("main")
    if main and not os.path.exists(os.path.join(ROOT, base, main)):
        problems.append((rel, '"main" points at %s, which does not exist' % main))

    def walk_exports(node, path):
        if isinstance(node, str):
            if node.startswith("./") and not os.path.exists(os.path.join(ROOT, base, node)):
                problems.append((rel, "exports%s points at %s, which does not exist"
                                 % (path, node)))
        elif isinstance(node, dict):
            for k, v in node.items():
                walk_exports(v, path + "[%s]" % k)

    walk_exports(pkg.get("exports", {}), "")

    # An exported file must actually be shipped: `files` gates what npm publishes.
    shipped = set(pkg.get("files", []))
    for entry in [pkg.get("main")] + [pkg.get("bin", {}).get(k) for k in pkg.get("bin", {})]:
        if not entry:
            continue
        top = entry.replace("./", "").split("/")[0]
        if top not in shipped:
            problems.append((rel, "%s is referenced but %r is not in \"files\"" % (entry, top)))


def self_test():
    """A guard that cannot fail is worthless: prove it detects a missing file."""
    problems = []
    saved = os.path.exists(os.path.join(ROOT, "python", "README.md"))
    if not saved:
        sys.stderr.write("self-test skipped: python/README.md is already missing\n")
        return 1
    tmp = os.path.join(ROOT, "python", "README.md")
    os.rename(tmp, tmp + ".selftest")
    try:
        check_python(problems)
    finally:
        os.rename(tmp + ".selftest", tmp)
    if not any("readme" in p[1] for p in problems):
        sys.stderr.write("self-test FAILED: a missing readme was not detected\n")
        return 1
    sys.stdout.write("self-test: a missing readme is detected\n")
    return 0


def main(argv):
    if "--self-test" in argv and self_test():
        return 1
    problems = []
    check_python(problems)
    check_js(problems)
    for where, what in problems:
        sys.stdout.write("%s: %s\n" % (where, what))
    if problems:
        sys.stderr.write("\n%d packaging problem(s). These break `python -m build` or ship a "
                         "broken package.\n" % len(problems))
        return 1
    sys.stdout.write("packaging manifests: every referenced file exists\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

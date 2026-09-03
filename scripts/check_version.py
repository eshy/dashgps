#!/usr/bin/env python3
"""Keep every declared version in lockstep.

The GPX writer stamps `creator="dashgps <version>"`, so a drift between the two cores would show
up as a parity failure in output bytes rather than as an obvious mistake.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(path):
    with open(os.path.join(ROOT, path)) as f:
        return f.read()


def main():
    want = read("VERSION").strip()
    found = {"VERSION": want}
    found["python/pyproject.toml"] = re.search(r'^version = "([^"]+)"',
                                               read("python/pyproject.toml"), re.M).group(1)
    found["python/src/dashgps/__init__.py"] = re.search(r'__version__ = "([^"]+)"',
                                                        read("python/src/dashgps/__init__.py")).group(1)
    found["js/package.json"] = json.loads(read("js/package.json"))["version"]
    found["js/src/index.js"] = re.search(r'VERSION = "([^"]+)"', read("js/src/index.js")).group(1)

    bad = {k: v for k, v in found.items() if v != want}
    for k, v in found.items():
        sys.stdout.write("  %-34s %s%s\n" % (k, v, "   <-- MISMATCH" if v != want else ""))
    if bad:
        sys.stderr.write("version mismatch: expected %s\n" % want)
        return 1
    sys.stdout.write("all versions agree on %s\n" % want)
    return 0


if __name__ == "__main__":
    sys.exit(main())

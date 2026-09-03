"""Optional passthrough to a user's own installed ExifTool.

ExifTool reads 124 kinds of timed GPS metadata; dashgps natively reads four. When the user has it
installed and asks for it, shelling out is strictly better than guessing.

ExifTool is NOT vendored, NOT linked and NOT a dependency. This module starts a subprocess and
reads its JSON output - data, not code. See NOTICE.md.
"""

import json
import os
import shutil
import subprocess

from .fmt import NAN, days_from_civil
from .model import ParseError, ParseResult, Point


def available(exe="exiftool"):
    return shutil.which(exe)


def _ts(s):
    # "2026:08:03 09:59:18Z" / "2026:08:03 09:59:18"
    if not s or len(s) < 19:
        return NAN
    try:
        y = int(s[0:4])
        mo = int(s[5:7])
        d = int(s[8:10])
        h = int(s[11:13])
        mi = int(s[14:16])
        se = int(s[17:19])
    except ValueError:
        return NAN
    return float(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se)


def _f(v):
    if v is None:
        return NAN
    try:
        return float(v)
    except (TypeError, ValueError):
        return NAN


def extract(path, exe="exiftool", timeout=180):
    """Parse one file via ExifTool. Raises ParseError if it yields no GPS."""
    cmd = [exe, "-q", "-q", "-n", "-j", "-ee", "-api", "LargeFileSupport=1", "-G1", path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ParseError("exiftool failed: %s" % e)
    if not proc.stdout.strip():
        raise ParseError("exiftool returned no metadata")
    try:
        docs = json.loads(proc.stdout.decode("utf-8", "replace"))
    except ValueError as e:
        raise ParseError("could not read exiftool output: %s" % e)

    name = os.path.basename(path)
    res = ParseResult("exiftool", "external", sources=[name], time_is_naive=False)
    for doc in docs:
        buckets = {}
        for key, val in doc.items():
            i = key.find(":")
            grp = key[:i] if i > 0 else ""
            tag = key[i + 1 :] if i > 0 else key
            buckets.setdefault(grp, {})[tag] = val
        for grp, tags in buckets.items():
            lat = _f(tags.get("GPSLatitude"))
            lon = _f(tags.get("GPSLongitude"))
            if lat != lat or lon != lon:
                continue
            t = _ts(tags.get("GPSDateTime") or tags.get("DateTimeOriginal") or "")
            spd = _f(tags.get("GPSSpeed"))
            ref = tags.get("GPSSpeedRef")
            if spd == spd:
                if ref == "N":
                    spd *= 1.852
                elif ref == "M":
                    spd *= 1.609344
            res.points.append(
                Point(t, lat, lon, spd, _f(tags.get("GPSTrack")), _f(tags.get("GPSAltitude")),
                      NAN, NAN, NAN, NAN, -1, 0)
            )
    if not res.points:
        raise ParseError("exiftool found no GPS in this file")
    res.points = [p for p in res.points if p.t == p.t]
    if not res.points:
        raise ParseError("exiftool found GPS but no usable timestamps")
    res.meta["via"] = "exiftool subprocess"
    res.warn("parsed by external exiftool, not by a dashgps format module")
    return res

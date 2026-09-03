"""dashgps command line interface."""

import argparse
import os
import sys

from . import __version__, exiftool
from .fmt import P_LATLON, byte_key, fixed, iso_local, json_value
from .group import group_results
from .io import CountingReader, FileReader
from .model import NoFormatMatch, ParseError, ParseOptions
from .postprocess import PostOptions
from .registry import formats, parse_auto, sniff_all
from .writers import csvw, geojsonw, gpxw, summaryw, zipw

DEFAULT_EXTS = (".ts", ".mp4", ".mov", ".m2ts", ".mts")

# Above this much input, full-scan formats are off unless explicitly asked for.
AUTO_DEEP_BYTES = 512 * 1024 * 1024


def _human(n):
    if n < 1024:
        return str(n) + " B"
    if n < 1024 * 1024:
        return fixed(n / 1024.0, 1) + " KB"
    if n < 1024 * 1024 * 1024:
        return fixed(n / 1048576.0, 1) + " MB"
    return fixed(n / 1073741824.0, 2) + " GB"


def _collect(paths, exts, recursive):
    out = []
    for p in paths:
        if os.path.isdir(p):
            if recursive:
                for root, dirs, files in os.walk(p):
                    dirs.sort(key=byte_key)
                    for f in sorted(files, key=byte_key):
                        if os.path.splitext(f)[1].lower() in exts:
                            out.append(os.path.join(root, f))
            else:
                for f in sorted(os.listdir(p), key=byte_key):
                    fp = os.path.join(p, f)
                    if os.path.isfile(fp) and os.path.splitext(f)[1].lower() in exts:
                        out.append(fp)
        elif os.path.isfile(p):
            out.append(p)
        else:
            sys.stderr.write("dashgps: no such file or directory: %s\n" % p)
    return sorted(out, key=byte_key)


def _tz_seconds(s):
    if not s:
        return 0
    sign = 1
    if s[0] == "-":
        sign = -1
        s = s[1:]
    elif s[0] == "+":
        s = s[1:]
    s = s.replace(":", "")
    if len(s) == 2:
        h, m = int(s), 0
    elif len(s) == 4:
        h, m = int(s[:2]), int(s[2:])
    else:
        raise ValueError("bad --tz-offset: expected +HH:MM")
    return sign * (h * 3600 + m * 60)


def _bbox(points):
    if not points:
        return None
    w = e = points[0].lon
    s = n = points[0].lat
    for p in points:
        if p.lon < w:
            w = p.lon
        if p.lon > e:
            e = p.lon
        if p.lat < s:
            s = p.lat
        if p.lat > n:
            n = p.lat
    return (w, s, e, n)


def _parse_one(path, opts, use_exiftool, exiftool_exe, only):
    name = os.path.basename(path)
    reader = CountingReader(FileReader(path, name))
    entry = {
        "name": name, "size": reader.size(), "format": None, "status": None,
        "records": 0, "points": 0, "dropped_nofix": 0, "t_start": None, "t_end": None,
        "bbox": None, "warnings": [], "error": None,
    }
    res = None
    try:
        res = parse_auto(reader, opts, only)
    except (NoFormatMatch, ParseError) as first:
        if use_exiftool:
            try:
                res = exiftool.extract(path, exiftool_exe)
            except ParseError as second:
                entry["error"] = "%s; exiftool: %s" % (first, second)
        else:
            entry["error"] = str(first)
    except Exception as e:  # a malformed file must not kill the batch
        entry["error"] = "%s: %s" % (type(e).__name__, e)

    if res is not None:
        entry["format"] = res.format_id
        entry["status"] = res.status
        entry["records"] = res.meta.get("records", len(res.points))
        entry["points"] = len(res.points)
        entry["dropped_nofix"] = res.dropped_nofix
        entry["warnings"] = list(res.warnings)
        if res.points:
            ts = [p.t for p in res.points]
            entry["t_start"] = iso_local(min(ts))
            entry["t_end"] = iso_local(max(ts))
            entry["bbox"] = _bbox(res.points)
    try:
        reader._r.close()
    except Exception:
        pass
    return entry, res, reader


def _render(group, sources, ctx, want):
    out = {}
    if "csv" in want:
        buf = []
        csvw.write(buf, group, sources)
        out["csv"] = "".join(buf)
    if "gpx" in want:
        buf = []
        gpxw.write(buf, group, ctx)
        out["gpx"] = "".join(buf)
    if "geojson" in want:
        buf = []
        geojsonw.write(buf, group, ctx)
        out["geojson"] = "".join(buf)
    return out


def _safe(label):
    # Explicitly ASCII: str.isalnum() is Unicode-aware and JavaScript has no equivalent, so
    # relying on it would let the two cores produce different filenames.
    ok = []
    for ch in label:
        c = ord(ch)
        good = (48 <= c <= 57) or (65 <= c <= 90) or (97 <= c <= 122) or ch in "-_."
        ok.append(ch if good else "_")
    return "".join(ok) or "group"


def cmd_extract(a):
    exts = tuple(x if x.startswith(".") else "." + x
                 for x in (a.include.lower().split(",") if a.include else DEFAULT_EXTS))
    files = _collect(a.paths, exts, a.recursive)
    if not files:
        sys.stderr.write("dashgps: no input files\n")
        return 2

    # Deep detection runs the full-scan formats, which cost a pass over every file that the
    # cheap formats did not claim. That is fine for a handful of clips and ruinous for a folder
    # of them, so it is on by default only for small inputs. Say --deep to force it.
    total = 0
    for f in files:
        try:
            total += os.path.getsize(f)
        except OSError:
            pass
    if a.deep:
        deep = True
    elif a.no_deep:
        deep = False
    else:
        deep = total <= AUTO_DEEP_BYTES
        if not deep and not a.quiet:
            sys.stderr.write(
                "dashgps: %s of input; skipping the full-scan formats. Pass --deep to run them, "
                "or --only <format> to force one.\n" % _human(total)
            )
    opts = ParseOptions(
        tail_cap=a.tail_cap, chunk=a.chunk, overlap=a.overlap, deep=deep,
        tz_offset_s=_tz_seconds(a.tz_offset), raw_nmea=a.raw_nmea, scan_cap=a.scan_cap,
    )
    post = PostOptions(a.max_speed, a.max_gap, a.min_run, a.decimate)
    want = tuple(x.strip() for x in a.format.split(",") if x.strip())

    entries = []
    results = []
    traces = []
    sources = []
    naive = True
    for i, path in enumerate(files):
        entry, res, reader = _parse_one(path, opts, a.exiftool is not None, a.exiftool, a.only)
        entries.append(entry)
        traces.append({
            "file": entry["name"],
            "format": entry["format"],
            "status": entry["status"],
            "meta": res.meta if res is not None else {},
            "warnings": entry["warnings"],
            "error": entry["error"],
            "read_ranges": [list(r) for r in reader.ranges],
            "bytes_read": reader.bytes_read,
            "file_size": entry["size"],
        })
        if res is not None:
            si = len(sources)
            sources.append(entry["name"])
            for p in res.points:
                p.src = si
            results.append(res)
            if not res.time_is_naive:
                naive = False
        if not a.quiet:
            sys.stderr.write(
                "[%d/%d] %s  %s  %d points%s\n"
                % (i + 1, len(files), entry["name"], entry["format"] or "-",
                   entry["points"], "  ERROR: " + entry["error"] if entry["error"] else "")
            )

    groups = group_results(results, a.group, post)
    ctx = {
        "version": __version__, "time_is_naive": naive,
        "include_glitch": a.include_glitch, "points": not a.no_points,
    }

    members = []
    for g in groups:
        rendered = _render(g, sources, ctx, want)
        base = _safe(g.label)
        for kind, ext in (("csv", ".csv"), ("gpx", ".gpx"), ("geojson", ".geojson")):
            if kind in rendered:
                members.append((base + ext, rendered[kind].encode("utf-8")))
    if "summary" in want:
        buf = []
        summaryw.write(buf, entries, groups, ctx)
        members.append(("summary.json", "".join(buf).encode("utf-8")))
    if a.meta:
        members.append(("meta.json", (json_value({"files": traces}) + "\n").encode("utf-8")))

    members.sort(key=lambda m: byte_key(m[0]))

    if a.zip:
        with open(a.zip, "wb") as f:
            f.write(zipw.build(members))
        if not a.quiet:
            sys.stderr.write("wrote %s (%d members)\n" % (a.zip, len(members)))
    else:
        os.makedirs(a.out, exist_ok=True)
        for name, data in members:
            with open(os.path.join(a.out, name), "wb") as f:
                f.write(data)
        if not a.quiet:
            sys.stderr.write("wrote %d files to %s\n" % (len(members), a.out))

    if a.json:
        buf = []
        summaryw.write(buf, entries, groups, ctx)
        sys.stdout.write("".join(buf))
    failed = 0
    for e in entries:
        if e["error"]:
            failed += 1
    return 1 if failed == len(entries) else 0


def cmd_formats(a):
    rows = [("ID", "NAME", "STATUS", "IO COST", "EXTENSIONS")]
    for f in formats():
        rows.append((f.id, f.name, f.status, f.cost, " ".join(f.extensions)))
    widths = [max(len(r[i]) for r in rows) for i in range(5)]
    for i, r in enumerate(rows):
        sys.stdout.write("  ".join(r[j].ljust(widths[j]) for j in range(5)).rstrip() + "\n")
        if i == 0:
            sys.stdout.write("  ".join("-" * widths[j] for j in range(5)) + "\n")
    sys.stdout.write(
        "\nverified            confirmed against real files from that camera, in quantity\n"
        "reverse-engineered  derived from a real artifact, not confirmed end to end\n"
        "untested            built from a published sample or a public standard -\n"
        "                    please send us one\n"
    )
    return 0


def cmd_inspect(a):
    """Diagnostics designed to be pasted into a bug report. Coordinates masked with --redact."""
    opts = ParseOptions(deep=True)
    reader = CountingReader(FileReader(a.file, os.path.basename(a.file)))
    n = reader.size()
    sys.stdout.write("file        %s\n" % os.path.basename(a.file))
    sys.stdout.write("size        %d bytes\n" % n)

    tail = reader.read_range(n - 16 if n > 16 else 0, n)
    sys.stdout.write("last 16     %s\n" % " ".join("%02x" % b for b in tail))
    sys.stdout.write("            %s\n" % "".join(
        chr(b) if 32 <= b < 127 else "." for b in tail))

    sys.stdout.write("\nsniff scores\n")
    for fid, score in sniff_all(reader, opts):
        sys.stdout.write("  %-20s %s\n" % (fid, fixed(score, 2)))

    # Fresh counter: the IO figure below should reflect what an extraction costs, not the cost
    # of asking every format in turn.
    reader = CountingReader(FileReader(a.file, os.path.basename(a.file)))
    try:
        res = parse_auto(reader, opts)
    except (NoFormatMatch, ParseError) as e:
        sys.stdout.write("\nno format parsed: %s\n" % e)
        sys.stdout.write("\nIO: %d bytes read in %d ranges\n"
                         % (reader.bytes_read, len(reader.ranges)))
        return 1

    sys.stdout.write("\nformat      %s (%s)\n" % (res.format_id, res.status))
    sys.stdout.write("meta        %s\n" % json_value(res.meta, 3).replace("\n", "\n            "))
    sys.stdout.write("points      %d  (dropped no-fix: %d)\n"
                     % (len(res.points), res.dropped_nofix))
    for w in res.warnings:
        sys.stdout.write("warning     %s\n" % w)

    if res.points:
        sys.stdout.write("\nfirst / last record\n")
        for p in (res.points[0], res.points[-1]):
            if a.redact:
                pos = "(redacted)"
            else:
                pos = fixed(p.lat, P_LATLON) + ", " + fixed(p.lon, P_LATLON)
            sys.stdout.write("  %s  %s  %s km/h\n"
                             % (iso_local(p.t), pos, fixed(p.speed_kmh, 1)))
    sys.stdout.write("\nIO          %d bytes read in %d ranges (%s%% of the file)\n"
                     % (reader.bytes_read, len(reader.ranges),
                        fixed(100.0 * reader.bytes_read / n if n else 0.0, 3)))
    if a.hexdump and res.meta.get("trailer_len"):
        start = n - int(res.meta["trailer_len"])
        blob = reader.read_range(start, min(start + 256, n))
        sys.stdout.write("\ntrailer head\n")
        for i in range(0, len(blob), 16):
            row = blob[i : i + 16]
            sys.stdout.write(
                "  %08x  %-47s  %s\n"
                % (start + i, " ".join("%02x" % b for b in row),
                   "".join(chr(b) if 32 <= b < 127 else "." for b in row))
            )
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="dashgps",
        description="Extract GPS tracks from dashcam video files.",
        epilog="Your video never leaves your machine. See https://github.com/dashgps/dashgps",
    )
    p.add_argument("--version", action="version", version="dashgps " + __version__)
    sub = p.add_subparsers(dest="cmd")

    e = sub.add_parser("extract", help="extract tracks (default)")
    e.add_argument("paths", nargs="+")
    e.add_argument("-o", "--out", default="dashgps-out")
    e.add_argument("--zip", help="write one zip archive instead of a directory")
    e.add_argument("--format", default="csv,gpx,geojson,summary")
    e.add_argument("--group", default="day", choices=("day", "file", "none"))
    e.add_argument("-r", "--recursive", action="store_true")
    e.add_argument("--include", help="comma-separated extensions, e.g. .ts,.mp4")
    e.add_argument("--only", help="force one format id; see `dashgps formats`")
    e.add_argument("--tz-offset", default="", help="the camera's UTC offset, e.g. -07:00")
    e.add_argument("--max-speed", type=float, default=400.0)
    e.add_argument("--max-gap", type=float, default=600.0)
    e.add_argument("--min-run", type=int, default=60)
    e.add_argument("--decimate", type=float, default=5.0)
    e.add_argument("--include-glitch", action="store_true")
    e.add_argument("--no-points", action="store_true", help="GeoJSON: lines only")
    e.add_argument("--deep", action="store_true",
                   help="always run the full-scan formats (default: only for small inputs)")
    e.add_argument("--no-deep", action="store_true", help="never run the full-scan formats")
    e.add_argument("--scan-cap", type=int, default=64 * 1024 * 1024,
                   help="bytes a full-scan format may read from each end of a file")
    e.add_argument("--raw-nmea", action="store_true")
    e.add_argument("--tail-cap", type=int, default=1024 * 1024)
    e.add_argument("--chunk", type=int, default=4 * 1024 * 1024)
    e.add_argument("--overlap", type=int, default=4096)
    e.add_argument("--exiftool", nargs="?", const="exiftool", default=None,
                   help="fall back to your installed exiftool for unmatched files")
    e.add_argument("--meta", action="store_true", help="also write meta.json with the IO trace")
    e.add_argument("--json", action="store_true", help="print the summary to stdout")
    e.add_argument("-q", "--quiet", action="store_true")
    e.set_defaults(func=cmd_extract)

    f = sub.add_parser("formats", help="list supported formats and their status")
    f.set_defaults(func=cmd_formats)

    i = sub.add_parser("inspect", help="diagnose one file; output is meant for a bug report")
    i.add_argument("file")
    i.add_argument("--redact", action="store_true", help="mask coordinates")
    i.add_argument("--hexdump", action="store_true")
    i.set_defaults(func=cmd_inspect)
    return p


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    known = ("extract", "formats", "inspect")
    if argv and argv[0] not in known and not argv[0].startswith("-"):
        argv.insert(0, "extract")
    p = build_parser()
    a = p.parse_args(argv)
    if not getattr(a, "func", None):
        p.print_help()
        return 2
    try:
        return a.func(a)
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

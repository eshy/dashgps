"""Summary JSON. spec/21-outputs.md.

A file that failed to parse still gets an entry, with `error` set. A batch never silently drops
a file.
"""

from ..fmt import P_DIST, P_DUR, P_LATLON, byte_key, fixed, iso_local, json_str


def _num(v, prec):
    s = fixed(v, prec)
    return s if s else "null"


def write(out, entries, groups, ctx):
    entries = sorted(entries, key=lambda e: byte_key(e["name"]))
    out.append("{\n")
    out.append('  "generator": ' + json_str("dashgps " + ctx.get("version", "0.0.0")) + ",\n")
    out.append('  "time_is_naive": ' + ("true" if ctx.get("time_is_naive", True) else "false")
               + ",\n")
    out.append('  "files": [\n')
    for i, e in enumerate(entries):
        out.append("    {\n")
        out.append('      "name": ' + json_str(e["name"]) + ",\n")
        out.append('      "size": ' + str(e["size"]) + ",\n")
        out.append('      "format": ' + (json_str(e["format"]) if e["format"] else "null") + ",\n")
        out.append('      "status": ' + (json_str(e["status"]) if e["status"] else "null") + ",\n")
        out.append('      "records": ' + str(e["records"]) + ",\n")
        out.append('      "points": ' + str(e["points"]) + ",\n")
        out.append('      "dropped_nofix": ' + str(e["dropped_nofix"]) + ",\n")
        out.append('      "t_start": ' + (json_str(e["t_start"]) if e["t_start"] else "null")
                   + ",\n")
        out.append('      "t_end": ' + (json_str(e["t_end"]) if e["t_end"] else "null") + ",\n")
        bb = e["bbox"]
        if bb is None:
            out.append('      "bbox": null,\n')
        else:
            out.append('      "bbox": [' + ", ".join(fixed(v, P_LATLON) for v in bb) + "],\n")
        out.append('      "warnings": [' + ", ".join(json_str(w) for w in e["warnings"]) + "],\n")
        out.append('      "error": ' + (json_str(e["error"]) if e["error"] else "null") + "\n")
        out.append("    }")
        out.append(",\n" if i < len(entries) - 1 else "\n")
    out.append("  ],\n")

    out.append('  "groups": [\n')
    for i, g in enumerate(groups):
        kept = [r for r in g.runs if not r.glitch]
        dist = 0.0
        for r in kept:
            dist += r.distance_km
        glitch_pts = 0
        for p in g.points:
            if p.outlier:
                glitch_pts += 1
        dur = (g.points[-1].t - g.points[0].t) if g.points else 0.0
        out.append("    {\n")
        out.append('      "label": ' + json_str(g.label) + ",\n")
        out.append('      "points": ' + str(len(g.points)) + ",\n")
        out.append('      "outlier_points": ' + str(glitch_pts) + ",\n")
        out.append('      "dropped_duplicate_times": ' + str(g.dropped_dupe) + ",\n")
        out.append('      "runs": ' + str(len(g.runs)) + ",\n")
        out.append('      "glitch_runs": ' + str(len(g.runs) - len(kept)) + ",\n")
        out.append('      "distance_km": ' + _num(dist, P_DIST) + ",\n")
        out.append('      "duration_s": ' + _num(dur, P_DUR) + ",\n")
        out.append('      "start": ' + (json_str(iso_local(g.points[0].t)) if g.points else "null")
                   + ",\n")
        out.append('      "end": ' + (json_str(iso_local(g.points[-1].t)) if g.points else "null")
                   + ",\n")
        out.append('      "sources": [' + ", ".join(json_str(s) for s in g.sources) + "]\n")
        out.append("    }")
        out.append(",\n" if i < len(groups) - 1 else "\n")
    out.append("  ],\n")

    tot_pts = 0
    tot_dist = 0.0
    for g in groups:
        tot_pts += len(g.points)
        for r in g.runs:
            if not r.glitch:
                tot_dist += r.distance_km
    ok = 0
    for e in entries:
        if not e["error"]:
            ok += 1
    out.append('  "totals": {\n')
    out.append('    "files": ' + str(len(entries)) + ",\n")
    out.append('    "files_parsed": ' + str(ok) + ",\n")
    out.append('    "groups": ' + str(len(groups)) + ",\n")
    out.append('    "points": ' + str(tot_pts) + ",\n")
    out.append('    "distance_km": ' + _num(tot_dist, P_DIST) + "\n")
    out.append("  }\n}\n")

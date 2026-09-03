"""GeoJSON writer with a hand-rolled emitter so key order is fixed. spec/21-outputs.md."""

from ..fmt import (
    P_ACCEL,
    P_ALT,
    P_ANGLE,
    P_DIST,
    P_LATLON,
    P_SPEED,
    fixed,
    iso_local,
    json_str,
)


def _coord(p):
    a = fixed(p.alt_m, P_ALT)
    base = "[" + fixed(p.lon, P_LATLON) + ", " + fixed(p.lat, P_LATLON)
    return base + ("]" if not a else ", " + a + "]")


def write(out, group, ctx):
    want_points = ctx.get("points", True)
    out.append('{\n  "type": "FeatureCollection",\n')
    out.append('  "properties": {\n')
    out.append('    "group": ' + json_str(group.label) + ",\n")
    out.append('    "generator": ' + json_str("dashgps " + ctx.get("version", "0.0.0")) + ",\n")
    out.append('    "time_is_naive": ' + ("true" if ctx.get("time_is_naive", True) else "false")
               + "\n")
    out.append("  },\n")
    out.append('  "features": [\n')

    first = True
    for ri, r in enumerate(group.runs):
        if r.glitch and not ctx.get("include_glitch"):
            continue
        if r.end - r.start < 2:
            continue
        if not first:
            out.append(",\n")
        first = False
        out.append("    {\n")
        out.append('      "type": "Feature",\n')
        out.append('      "properties": {\n')
        out.append('        "run": ' + str(ri) + ",\n")
        out.append('        "points": ' + str(r.end - r.start) + ",\n")
        out.append('        "distance_km": ' + (fixed(r.distance_km, P_DIST) or "0.000") + ",\n")
        out.append('        "outlier": ' + ("true" if r.glitch else "false") + ",\n")
        out.append('        "start": ' + json_str(iso_local(group.points[r.start].t)) + ",\n")
        out.append('        "end": ' + json_str(iso_local(group.points[r.end - 1].t)) + "\n")
        out.append("      },\n")
        out.append('      "geometry": {\n')
        out.append('        "type": "LineString",\n')
        out.append('        "coordinates": [\n')
        for i in range(r.start, r.end):
            out.append("          " + _coord(group.points[i]))
            out.append(",\n" if i < r.end - 1 else "\n")
        out.append("        ]\n      }\n    }")

    if want_points:
        for ri, r in enumerate(group.runs):
            if r.glitch and not ctx.get("include_glitch"):
                continue
            for i in range(r.start, r.end):
                p = group.points[i]
                if not first:
                    out.append(",\n")
                first = False
                out.append("    {\n")
                out.append('      "type": "Feature",\n')
                out.append('      "properties": {\n')
                out.append('        "timestamp": ' + json_str(iso_local(p.t)) + ",\n")
                out.append('        "speed_kmh": ' + (fixed(p.speed_kmh, P_SPEED) or "null")
                           + ",\n")
                out.append('        "heading_deg": ' + (fixed(p.heading_deg, P_ANGLE) or "null")
                           + ",\n")
                out.append('        "accel": [' + (fixed(p.ax, P_ACCEL) or "null") + ", "
                           + (fixed(p.ay, P_ACCEL) or "null") + ", "
                           + (fixed(p.az, P_ACCEL) or "null") + "],\n")
                out.append('        "run": ' + str(ri) + ",\n")
                out.append('        "outlier": ' + ("true" if p.outlier else "false") + "\n")
                out.append("      },\n")
                out.append('      "geometry": { "type": "Point", "coordinates": '
                           + _coord(p) + " }\n    }")
    out.append("\n  ]\n}\n")

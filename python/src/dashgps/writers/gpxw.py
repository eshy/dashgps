"""GPX 1.1 writer. spec/21-outputs.md.

One <trkseg> per non-glitch run, so a consumer that draws segments gets the recording gaps right
without having to know about dt_s.
"""

from ..fmt import P_ALT, P_ANGLE, P_LATLON, P_SPEED, fixed, iso_z, xml_text

NS = "http://www.topografix.com/GPX/1/1"
EXT_NS = "https://github.com/dashgps/dashgps/ns/1"


def write(out, group, ctx):
    version = ctx.get("version", "0.0.0")
    naive = ctx.get("time_is_naive", True)
    out.append('<?xml version="1.0" encoding="UTF-8"?>\n')
    out.append(
        '<gpx version="1.1" creator="dashgps ' + xml_text(version) + '" xmlns="' + NS
        + '" xmlns:dashgps="' + EXT_NS + '">\n'
    )
    if naive:
        out.append(
            "  <!-- Times are the camera's own clock, which carries no timezone. They are\n"
            "       written with a Z suffix because GPX requires one, but they are NOT UTC\n"
            "       unless dashgps was run with --tz-offset. -->\n"
        )
    out.append("  <metadata>\n")
    out.append("    <name>" + xml_text(group.label) + "</name>\n")
    if group.points:
        out.append("    <time>" + iso_z(group.points[0].t) + "</time>\n")
    out.append("  </metadata>\n")

    segs = [r for r in group.runs if not r.glitch]
    if segs:
        _trk(out, group, segs, group.label)
    if ctx.get("include_glitch"):
        bad = [r for r in group.runs if r.glitch]
        if bad:
            _trk(out, group, bad, group.label + " (glitch)")
    out.append("</gpx>\n")


def _trk(out, group, runs, name):
    out.append("  <trk>\n")
    out.append("    <name>" + xml_text(name) + "</name>\n")
    for r in runs:
        out.append("    <trkseg>\n")
        for i in range(r.start, r.end):
            p = group.points[i]
            out.append(
                '      <trkpt lat="' + fixed(p.lat, P_LATLON)
                + '" lon="' + fixed(p.lon, P_LATLON) + '">\n'
            )
            a = fixed(p.alt_m, P_ALT)
            if a:
                out.append("        <ele>" + a + "</ele>\n")
            out.append("        <time>" + iso_z(p.t) + "</time>\n")
            s = fixed(p.speed_kmh, P_SPEED)
            h = fixed(p.heading_deg, P_ANGLE)
            if s or h:
                out.append("        <extensions>\n")
                if s:
                    out.append("          <dashgps:speed_kmh>" + s + "</dashgps:speed_kmh>\n")
                if h:
                    out.append("          <dashgps:heading_deg>" + h + "</dashgps:heading_deg>\n")
                out.append("        </extensions>\n")
            out.append("      </trkpt>\n")
        out.append("    </trkseg>\n")
    out.append("  </trk>\n")

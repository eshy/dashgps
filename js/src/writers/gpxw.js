// GPX 1.1 writer. spec/21-outputs.md  (mirrors python/src/dashgps/writers/gpxw.py)

import { P_ALT, P_ANGLE, P_LATLON, P_SPEED, fixed, isoZ, xmlText } from "../fmt.js";

const NS = "http://www.topografix.com/GPX/1/1";
// A URN, not a URL: an XML namespace is an identifier and is never fetched, and this one must
// stay stable if the project ever moves. spec/21-outputs.md
const EXT_NS = "urn:dashgps:gpx:1";

export function write(out, group, ctx) {
  const version = ctx.version || "0.0.0";
  const naive = ctx.timeIsNaive !== false;
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push('<gpx version="1.1" creator="dashgps ' + xmlText(version) + '" xmlns="' + NS +
           '" xmlns:dashgps="' + EXT_NS + '">\n');
  if (naive) {
    out.push("  <!-- Times are the camera's own clock, which carries no timezone. They are\n" +
             "       written with a Z suffix because GPX requires one, but they are NOT UTC\n" +
             "       unless dashgps was run with --tz-offset. -->\n");
  }
  out.push("  <metadata>\n");
  out.push("    <name>" + xmlText(group.label) + "</name>\n");
  if (group.points.length) out.push("    <time>" + isoZ(group.points[0].t) + "</time>\n");
  out.push("  </metadata>\n");

  const segs = group.runs.filter((r) => !r.glitch);
  if (segs.length) trk(out, group, segs, group.label);
  if (ctx.includeGlitch) {
    const bad = group.runs.filter((r) => r.glitch);
    if (bad.length) trk(out, group, bad, group.label + " (glitch)");
  }
  out.push("</gpx>\n");
}

function trk(out, group, runs, name) {
  out.push("  <trk>\n");
  out.push("    <name>" + xmlText(name) + "</name>\n");
  for (const r of runs) {
    out.push("    <trkseg>\n");
    for (let i = r.start; i < r.end; i++) {
      const p = group.points[i];
      out.push('      <trkpt lat="' + fixed(p.lat, P_LATLON) + '" lon="' +
               fixed(p.lon, P_LATLON) + '">\n');
      const a = fixed(p.altM, P_ALT);
      if (a) out.push("        <ele>" + a + "</ele>\n");
      out.push("        <time>" + isoZ(p.t) + "</time>\n");
      const s = fixed(p.speedKmh, P_SPEED);
      const h = fixed(p.headingDeg, P_ANGLE);
      if (s || h) {
        out.push("        <extensions>\n");
        if (s) out.push("          <dashgps:speed_kmh>" + s + "</dashgps:speed_kmh>\n");
        if (h) out.push("          <dashgps:heading_deg>" + h + "</dashgps:heading_deg>\n");
        out.push("        </extensions>\n");
      }
      out.push("      </trkpt>\n");
    }
    out.push("    </trkseg>\n");
  }
  out.push("  </trk>\n");
}

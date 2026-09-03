// GeoJSON writer with a hand-rolled emitter so key order is fixed. spec/21-outputs.md
// Mirrors python/src/dashgps/writers/geojsonw.py

import {
  P_ACCEL, P_ALT, P_ANGLE, P_DIST, P_LATLON, P_SPEED, fixed, isoLocal, jsonStr,
} from "../fmt.js";

function coord(p) {
  const a = fixed(p.altM, P_ALT);
  const base = "[" + fixed(p.lon, P_LATLON) + ", " + fixed(p.lat, P_LATLON);
  return a ? base + ", " + a + "]" : base + "]";
}

export function write(out, group, ctx) {
  const wantPoints = ctx.points !== false;
  out.push('{\n  "type": "FeatureCollection",\n');
  out.push('  "properties": {\n');
  out.push('    "group": ' + jsonStr(group.label) + ",\n");
  out.push('    "generator": ' + jsonStr("dashgps " + (ctx.version || "0.0.0")) + ",\n");
  out.push('    "time_is_naive": ' + (ctx.timeIsNaive !== false ? "true" : "false") + "\n");
  out.push("  },\n");
  out.push('  "features": [\n');

  let first = true;
  for (let ri = 0; ri < group.runs.length; ri++) {
    const r = group.runs[ri];
    if (r.glitch && !ctx.includeGlitch) continue;
    if (r.end - r.start < 2) continue;
    if (!first) out.push(",\n");
    first = false;
    out.push("    {\n");
    out.push('      "type": "Feature",\n');
    out.push('      "properties": {\n');
    out.push('        "run": ' + ri + ",\n");
    out.push('        "points": ' + (r.end - r.start) + ",\n");
    out.push('        "distance_km": ' + (fixed(r.distanceKm, P_DIST) || "0.000") + ",\n");
    out.push('        "outlier": ' + (r.glitch ? "true" : "false") + ",\n");
    out.push('        "start": ' + jsonStr(isoLocal(group.points[r.start].t)) + ",\n");
    out.push('        "end": ' + jsonStr(isoLocal(group.points[r.end - 1].t)) + "\n");
    out.push("      },\n");
    out.push('      "geometry": {\n');
    out.push('        "type": "LineString",\n');
    out.push('        "coordinates": [\n');
    for (let i = r.start; i < r.end; i++) {
      out.push("          " + coord(group.points[i]));
      out.push(i < r.end - 1 ? ",\n" : "\n");
    }
    out.push("        ]\n      }\n    }");
  }

  if (wantPoints) {
    for (let ri = 0; ri < group.runs.length; ri++) {
      const r = group.runs[ri];
      if (r.glitch && !ctx.includeGlitch) continue;
      for (let i = r.start; i < r.end; i++) {
        const p = group.points[i];
        if (!first) out.push(",\n");
        first = false;
        out.push("    {\n");
        out.push('      "type": "Feature",\n');
        out.push('      "properties": {\n');
        out.push('        "timestamp": ' + jsonStr(isoLocal(p.t)) + ",\n");
        out.push('        "speed_kmh": ' + (fixed(p.speedKmh, P_SPEED) || "null") + ",\n");
        out.push('        "heading_deg": ' + (fixed(p.headingDeg, P_ANGLE) || "null") + ",\n");
        out.push('        "accel": [' + (fixed(p.ax, P_ACCEL) || "null") + ", " +
                 (fixed(p.ay, P_ACCEL) || "null") + ", " +
                 (fixed(p.az, P_ACCEL) || "null") + "],\n");
        out.push('        "run": ' + ri + ",\n");
        out.push('        "outlier": ' + (p.outlier ? "true" : "false") + "\n");
        out.push("      },\n");
        out.push('      "geometry": { "type": "Point", "coordinates": ' + coord(p) + " }\n    }");
      }
    }
  }
  out.push("\n  ]\n}\n");
}

// Summary JSON. spec/21-outputs.md  (mirrors python/src/dashgps/writers/summaryw.py)
//
// A file that failed to parse still gets an entry, with `error` set. A batch never silently
// drops a file.

import { P_DIST, P_DUR, P_LATLON, cmpNames, fixed, isoLocal, jsonStr } from "../fmt.js";

function num(v, prec) {
  const s = fixed(v, prec);
  return s || "null";
}

export function write(out, entries, groups, ctx) {
  entries = entries.slice().sort((a, b) => cmpNames(a.name, b.name));
  out.push("{\n");
  out.push('  "generator": ' + jsonStr("dashgps " + (ctx.version || "0.0.0")) + ",\n");
  out.push('  "time_is_naive": ' + (ctx.timeIsNaive !== false ? "true" : "false") + ",\n");
  out.push('  "files": [\n');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    out.push("    {\n");
    out.push('      "name": ' + jsonStr(e.name) + ",\n");
    out.push('      "size": ' + e.size + ",\n");
    out.push('      "format": ' + (e.format ? jsonStr(e.format) : "null") + ",\n");
    out.push('      "status": ' + (e.status ? jsonStr(e.status) : "null") + ",\n");
    out.push('      "records": ' + e.records + ",\n");
    out.push('      "points": ' + e.points + ",\n");
    out.push('      "dropped_nofix": ' + e.droppedNofix + ",\n");
    out.push('      "t_start": ' + (e.tStart ? jsonStr(e.tStart) : "null") + ",\n");
    out.push('      "t_end": ' + (e.tEnd ? jsonStr(e.tEnd) : "null") + ",\n");
    if (!e.bbox) out.push('      "bbox": null,\n');
    else out.push('      "bbox": [' + e.bbox.map((v) => fixed(v, P_LATLON)).join(", ") + "],\n");
    out.push('      "warnings": [' + e.warnings.map(jsonStr).join(", ") + "],\n");
    out.push('      "error": ' + (e.error ? jsonStr(e.error) : "null") + "\n");
    out.push("    }");
    out.push(i < entries.length - 1 ? ",\n" : "\n");
  }
  out.push("  ],\n");

  out.push('  "groups": [\n');
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const kept = g.runs.filter((r) => !r.glitch);
    let dist = 0;
    for (const r of kept) dist += r.distanceKm;
    let glitchPts = 0;
    for (const p of g.points) if (p.outlier) glitchPts += 1;
    const dur = g.points.length ? g.points[g.points.length - 1].t - g.points[0].t : 0;
    out.push("    {\n");
    out.push('      "label": ' + jsonStr(g.label) + ",\n");
    out.push('      "points": ' + g.points.length + ",\n");
    out.push('      "outlier_points": ' + glitchPts + ",\n");
    out.push('      "dropped_duplicate_times": ' + (g.droppedDupe || 0) + ",\n");
    out.push('      "runs": ' + g.runs.length + ",\n");
    out.push('      "glitch_runs": ' + (g.runs.length - kept.length) + ",\n");
    out.push('      "distance_km": ' + num(dist, P_DIST) + ",\n");
    out.push('      "duration_s": ' + num(dur, P_DUR) + ",\n");
    out.push('      "start": ' + (g.points.length ? jsonStr(isoLocal(g.points[0].t)) : "null") + ",\n");
    out.push('      "end": ' + (g.points.length
      ? jsonStr(isoLocal(g.points[g.points.length - 1].t)) : "null") + ",\n");
    out.push('      "sources": [' + g.sources.map(jsonStr).join(", ") + "]\n");
    out.push("    }");
    out.push(i < groups.length - 1 ? ",\n" : "\n");
  }
  out.push("  ],\n");

  let totPts = 0;
  let totDist = 0;
  for (const g of groups) {
    totPts += g.points.length;
    for (const r of g.runs) if (!r.glitch) totDist += r.distanceKm;
  }
  let ok = 0;
  for (const e of entries) if (!e.error) ok += 1;
  out.push('  "totals": {\n');
  out.push('    "files": ' + entries.length + ",\n");
  out.push('    "files_parsed": ' + ok + ",\n");
  out.push('    "groups": ' + groups.length + ",\n");
  out.push('    "points": ' + totPts + ",\n");
  out.push('    "distance_km": ' + num(totDist, P_DIST) + "\n");
  out.push("  }\n}\n");
}

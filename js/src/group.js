// Grouping and de-duplication. spec/21-outputs.md
// Mirrors python/src/dashgps/group.py

import { cmpNames, dateLocal } from "./fmt.js";
import { postprocess } from "./postprocess.js";

const DEDUP_EPS = 1e-7;

export class Group {
  constructor(label) {
    this.label = label;
    this.points = [];
    this.runs = [];
    this.sources = [];
    this.droppedDupe = 0;
  }
}

export function stem(name) {
  let s = name;
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i >= 0) s = s.slice(i + 1);
  const j = s.lastIndexOf(".");
  return j > 0 ? s.slice(0, j) : s;
}

// Collapse consecutive points that share a timestamp. Returns [points, dropped].
//
// Two sources of duplicates, both real: clips overlap at their boundaries, and the receiver
// sometimes emits two fixes stamped with the same second. Keeping both would leave dt = 0, which
// the run logic cannot interpret - it would look like a teleport and flag good data as a glitch.
// We keep the FIRST; see the Python twin for why that choice is compatibility, not accuracy.
export function dedupe(points) {
  const out = [];
  let dropped = 0;
  for (const p of points) {
    if (out.length && out[out.length - 1].t === p.t) { dropped += 1; continue; }
    out.push(p);
  }
  return [out, dropped];
}

// Post-processing runs AFTER grouping so a run can span clip boundaries. spec 20.1
export function groupResults(results, mode, postOpt) {
  const buckets = new Map();
  const order = [];
  for (const res of results) {
    const src = res.sources.length ? res.sources[0] : "?";
    for (const p of res.points) {
      let label;
      if (mode === "day") label = dateLocal(p.t);
      else if (mode === "file") label = stem(src);
      else label = "all";
      let g = buckets.get(label);
      if (g === undefined) {
        g = new Group(label);
        buckets.set(label, g);
        order.push(label);
      }
      g.points.push(p);
      if (g.sources.indexOf(src) < 0) g.sources.push(src);
    }
  }
  const groups = [];
  for (const label of order.slice().sort(cmpNames)) {
    const g = buckets.get(label);
    g.points.sort((a, b) => (a.t - b.t) || (a.src - b.src) || (a.idx - b.idx));
    const [pts, dropped] = dedupe(g.points);
    g.points = pts;
    g.droppedDupe = dropped;
    g.sources.sort(cmpNames);
    g.runs = postprocess(g.points, postOpt);
    groups.push(g);
  }
  return groups;
}

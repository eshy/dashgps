// Runs, glitch flagging, dtS and decimated distance. spec/20-postprocess.md
// Mirrors python/src/dashgps/postprocess.py

import { haversineM } from "./fmt.js";

export class PostOptions {
  constructor(o = {}) {
    this.maxSpeedKmh = o.maxSpeedKmh === undefined ? 400 : o.maxSpeedKmh;
    this.maxGapS = o.maxGapS === undefined ? 600 : o.maxGapS;
    this.minRunPoints = o.minRunPoints === undefined ? 60 : o.minRunPoints;
    this.decimateS = o.decimateS === undefined ? 5 : o.decimateS;
  }
}

export class Run {
  constructor(start, end) {
    this.start = start;
    this.end = end;
    this.entryImpossible = false;
    this.exitImpossible = false;
    this.glitch = false;
    this.distanceKm = 0;
  }
}

// Stable total order by (t, src, idx). spec 30.4
export function sortPoints(points) {
  points.sort((a, b) => (a.t - b.t) || (a.src - b.src) || (a.idx - b.idx));
}

export function postprocess(points, opt) {
  const n = points.length;
  if (n === 0) return [];

  sortPoints(points);

  // Clause 3
  const bounds = [0];
  const impossible = new Set();
  for (let i = 1; i < n; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = b.t - a.t;
    b.dtS = dt;
    let split = false;
    let imp = false;
    if (dt > opt.maxGapS) {
      split = true;
    } else if (dt <= 0) {
      // Only reachable if a caller skipped de-duplication. A repeated timestamp is a clock quirk,
      // not a teleport, so it breaks the run without condemning it as a glitch.
      split = true;
    } else {
      const km = haversineM(a.lat, a.lon, b.lat, b.lon) / 1000;
      if (km / (dt / 3600) > opt.maxSpeedKmh) { split = true; imp = true; }
    }
    if (split) {
      bounds.push(i);
      if (imp) impossible.add(i);
    }
  }
  bounds.push(n);

  const runs = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const r = new Run(bounds[k], bounds[k + 1]);
    r.entryImpossible = impossible.has(bounds[k]);
    r.exitImpossible = impossible.has(bounds[k + 1]);
    runs.push(r);
  }

  // Clause 4: dtS is undefined at the start of a run.
  for (const r of runs) points[r.start].dtS = NaN;

  // Clause 5: flag, never delete.
  for (let ri = 0; ri < runs.length; ri++) {
    const r = runs[ri];
    if (r.end - r.start < opt.minRunPoints && (r.entryImpossible || r.exitImpossible)) {
      r.glitch = true;
    }
    for (let i = r.start; i < r.end; i++) {
      points[i].run = ri;
      points[i].outlier = r.glitch ? 1 : 0;
    }
  }

  // Clause 6: decimated distance.
  for (const r of runs) {
    if (r.glitch) continue;
    let total = 0;
    let anchor = points[r.start];
    let last = anchor;
    for (let i = r.start + 1; i < r.end; i++) {
      const p = points[i];
      last = p;
      if (p.t - anchor.t >= opt.decimateS) {
        total += haversineM(anchor.lat, anchor.lon, p.lat, p.lon);
        anchor = p;
      }
    }
    if (last !== anchor) total += haversineM(anchor.lat, anchor.lon, last.lat, last.lon);
    r.distanceKm = total / 1000;
  }
  return runs;
}

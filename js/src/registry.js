// Format registry and auto-detection. spec/00-model.md
// Mirrors python/src/dashgps/registry.py

import { NoFormatMatch, ParseError } from "./model.js";

export const COST_RANK = { tail: 0, head: 1, "full-scan": 2 };

const REGISTRY = [];

export function register(id, name, status, cost, extensions, sniff, parse) {
  REGISTRY.push({ id, name, status, cost, extensions, sniff, parse, order: REGISTRY.length });
}

export function formats() { return REGISTRY.slice(); }

export function byId(id) {
  for (const f of REGISTRY) if (f.id === id) return f;
  return null;
}

export async function sniffAll(reader, opts) {
  const out = [];
  for (const spec of REGISTRY) {
    let score = 0;
    try { score = await spec.sniff(reader, opts); } catch (e) { score = 0; }
    out.push([spec.id, score]);
  }
  return out;
}

function best(cands) {
  let win = null;
  for (const [spec, score] of cands) {
    const key = [-score, COST_RANK[spec.cost], spec.order];
    if (win === null || key[0] < win.key[0] ||
        (key[0] === win.key[0] && (key[1] < win.key[1] ||
        (key[1] === win.key[1] && key[2] < win.key[2])))) {
      win = { key, spec, score };
    }
  }
  return win ? [win.spec, win.score] : [null, 0];
}

export async function parseAuto(reader, opts, only) {
  opts.probe = {};
  if (only) {
    const spec = byId(only);
    if (spec === null) throw new ParseError("unknown format id: " + only);
    return spec.parse(reader, opts);
  }
  const scores = [];
  for (const [tier, threshold] of [["tail", 0.9], ["head", 0.9], ["full-scan", 0.5]]) {
    if (tier === "full-scan" && !opts.deep) continue;
    const cands = [];
    let confident = null;
    for (const spec of REGISTRY) {
      if (spec.cost !== tier) continue;
      let score = 0;
      try { score = await spec.sniff(reader, opts); } catch (e) { score = 0; }
      scores.push([spec.id, score]);
      if (score > 0) cands.push([spec, score]);
      // Short-circuit: a confident hit stops the tier, so we never run an expensive scan for a
      // format we are not going to choose. Registration order decides.
      if (score >= 0.9) { confident = spec; break; }
    }
    if (confident !== null) return confident.parse(reader, opts);
    const [spec, score] = best(cands);
    if (spec !== null && score >= threshold) return spec.parse(reader, opts);
  }
  throw new NoFormatMatch(scores);
}

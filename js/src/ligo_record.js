// The LigoGPS ASCII record grammar. Mirrors python/src/dashgps/ligo_record.py.
// spec/01-ligogps-ts-trailer.md §1.5-1.7. No regular expressions: the grammar is positional.

import { ascii } from "./io.js";
import { epochFromCivil, parseNum } from "./fmt.js";

export const LIGO_MAGIC = ascii("LIGOGPSINFO");

export const STRIDE_MIN = 100;
export const STRIDE_MAX = 1024;
export const STRIDE_FALLBACKS = [132, 140];
export const STRIDE_SEARCH = 2048;

function isDigit(b) { return b >= 48 && b <= 57; }

// spec 01 clause 5
export function isDateShape(slab, off) {
  if (!slab.covers(off, 11)) return false;
  const d = slab.bytes(off, 11);
  if (d[4] !== 0x2f || d[7] !== 0x2f || d[10] !== 0x20) return false;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!isDigit(d[i])) return false;
  return true;
}

// spec 01 clause 6. A wrong stride produces plausible-looking garbage, so a candidate is only
// accepted once a third record validates.
export function detectStride(slab, firstRec, blockEnd) {
  const off1 = firstRec + 4;
  if (!isDateShape(slab, off1)) return [0, "first record does not start with a date"];

  const limit = Math.min(off1 + STRIDE_SEARCH, blockEnd);
  for (let stride = STRIDE_MIN; stride <= STRIDE_MAX; stride += 4) {
    const p2 = off1 + stride;
    if (p2 + 11 > limit) break;
    if (isDateShape(slab, p2)) {
      const p3 = off1 + 2 * stride;
      if (p3 + 11 > blockEnd || isDateShape(slab, p3)) return [stride, null];
    }
  }
  for (const cand of STRIDE_FALLBACKS) {
    if (firstRec + cand > blockEnd) return [cand, "single record; assuming stride " + cand];
    if (isDateShape(slab, off1 + cand)) {
      return [cand, "stride autodetect inconclusive; using " + cand];
    }
  }
  if (firstRec + STRIDE_FALLBACKS[0] >= blockEnd) {
    return [STRIDE_FALLBACKS[0], "single record; assuming stride " + STRIDE_FALLBACKS[0]];
  }
  return [0, "could not determine record stride"];
}

function coord(tok, posLetter, negLetter) {
  if (tok.length < 3 || tok[1] !== ":") return null;
  const h = tok[0];
  let sign;
  if (h === posLetter) sign = 1;
  else if (h === negLetter) sign = -1;
  else return null;
  const v = parseNum(tok.slice(2));
  if (v !== v) return null;
  return sign * v;
}
export { coord as _coord };

export function dateParts(tok) {
  if (tok.length !== 10 || tok[4] !== "/" || tok[7] !== "/") return null;
  const y = Number(tok.slice(0, 4)), mo = Number(tok.slice(5, 7)), d = Number(tok.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1980 || y > 2200) return null;
  return [y, mo, d];
}

export function timeParts(tok) {
  if (tok.length !== 8 || tok[2] !== ":" || tok[5] !== ":") return null;
  const h = Number(tok.slice(0, 2)), mi = Number(tok.slice(3, 5)), s = Number(tok.slice(6, 8));
  if (!Number.isInteger(h) || !Number.isInteger(mi) || !Number.isInteger(s)) return null;
  if (h > 23 || mi > 59 || s > 60) return null;
  return [h, mi, s === 60 ? 59 : s];
}

// Split on single spaces, dropping empties. Deterministic in both languages.
export function splitTokens(text) {
  const out = [];
  for (const t of text.split(" ")) if (t) out.push(t);
  return out;
}

// spec 01 §1.5. Tokens 0-5 are positional; anything after is dispatched on its prefix, so
// firmware that omits A/H/M still parses.
export function parseLigoText(text) {
  const toks = splitTokens(text);
  if (toks.length < 6) return null;
  const dp = dateParts(toks[0]);
  const tp = timeParts(toks[1]);
  if (dp === null || tp === null) return null;
  const lat = coord(toks[2], "N", "S");
  const lon = coord(toks[3], "E", "W");
  if (lat === null || lon === null) return null;
  if (toks[5] !== "km/h") return null;

  const f = {
    t: epochFromCivil(dp[0], dp[1], dp[2], tp[0], tp[1], tp[2]),
    lat, lon,
    speedKmh: parseNum(toks[4]),
    headingDeg: NaN, altM: NaN, magvarDeg: NaN,
    ax: NaN, ay: NaN, az: NaN,
    nofix: false,
  };
  for (let i = 6; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.length < 3 || tok[1] !== ":") continue;
    const v = parseNum(tok.slice(2));
    switch (tok[0]) {
      case "x": f.ax = v; break;
      case "y": f.ay = v; break;
      case "z": f.az = v; break;
      case "A": f.headingDeg = v; break;
      case "H": f.altM = v; break;
      case "M": f.magvarDeg = v; break;
      default: break;
    }
  }
  // A receiver with no fix writes literal zeros rather than omitting the record.
  if (lat === 0 && lon === 0) f.nofix = true;
  return f;
}

export function recordText(slab, recOff, stride, indexPrefix = 4) {
  let bodyLen = stride - indexPrefix;
  if (!slab.covers(recOff + indexPrefix, 1)) return "";
  const avail = slab.end - (recOff + indexPrefix);
  if (bodyLen > avail) bodyLen = avail;
  if (bodyLen <= 0) return "";
  const raw = slab.bytes(recOff + indexPrefix, bodyLen);
  let n = raw.length;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) { n = i; break; }
  }
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(raw[i]);
  return out;
}

// spec 01 clause 5
export function isAsciiRegion(slab, off, n) {
  if (!slab.covers(off, 1)) return false;
  const avail = slab.end - off;
  if (n > avail) n = avail;
  if (n <= 0) return false;
  const b = slab.bytes(off, n);
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (v !== 0 && (v < 0x20 || v > 0x7e)) return false;
  }
  return true;
}

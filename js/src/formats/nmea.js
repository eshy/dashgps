// NMEA 0183 sentences in TS private streams or MP4 atoms. spec/04-nmea.md
// Mirrors python/src/dashgps/formats/nmea.py

import { iterAtoms, looksLikeMp4 } from "../containers/mp4.js";
import { WELL_KNOWN_PIDS, detectAlignment, iterPes } from "../containers/ts.js";
import { cappedWindows, scanChunks } from "../io.js";
import { epochFromCivil, parseNum } from "../fmt.js";
import { ParseError, ParseResult, Point } from "../model.js";

export const FORMAT_ID = "nmea";
export const STATUS = "untested";

const ATOMS = new Set(["free", "skip", "udta", "gps "]);
const KNOTS_TO_KMH = 1.852;
const HEX = "0123456789ABCDEF";

function checksumOk(buf, from, to, given) {
  let x = 0;
  for (let i = from; i < to; i++) x ^= buf[i];
  return given === HEX[(x >> 4) & 15] + HEX[x & 15];
}

export function* iterSentences(buf) {
  let i = 0;
  const n = buf.length;
  for (;;) {
    let s = -1;
    for (let k = i; k < n; k++) { if (buf[k] === 0x24) { s = k; break; } }
    if (s < 0) return;
    let e = s + 1;
    while (e < n && buf[e] !== 0x24 && buf[e] !== 0x00 && buf[e] !== 0x0d && buf[e] !== 0x0a) e++;
    i = e > s ? e : s + 1;
    let end = e;
    let ok = true;
    let star = -1;
    for (let k = e - 1; k > s; k--) { if (buf[k] === 0x2a) { star = k; break; } }
    if (star >= 0 && e - star >= 3) {
      ok = checksumOk(buf, s + 1, star,
        String.fromCharCode(buf[star + 1], buf[star + 2]).toUpperCase());
      end = star;
    }
    if (end - s - 1 < 6) continue;
    let text = "";
    for (let k = s + 1; k < end; k++) text += String.fromCharCode(buf[k]);
    const parts = text.split(",");
    if (!parts.length || parts[0].length < 5) continue;
    yield [parts[0], parts, ok];
  }
}

function dmToDeg(v, hemi, pos) {
  if (v !== v) return NaN;
  const deg = Math.trunc(v / 100);
  const out = deg + (v - deg * 100) / 60;
  return hemi === pos ? out : -out;
}

function rmc(parts) {
  if (parts.length < 10 || parts[2] !== "A") return null;
  const tm = parts[1];
  const dt = parts[9];
  if (tm.length < 6 || dt.length !== 6) return null;
  const hh = Number(tm.slice(0, 2)), mi = Number(tm.slice(2, 4)), ss = Number(tm.slice(4, 6));
  const dd = Number(dt.slice(0, 2)), mo = Number(dt.slice(2, 4)), yy = Number(dt.slice(4, 6));
  if (![hh, mi, ss, dd, mo, yy].every(Number.isInteger)) return null;
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  const lat = dmToDeg(parseNum(parts[3]), parts[4], "N");
  const lon = dmToDeg(parseNum(parts[5]), parts[6], "E");
  if (lat !== lat || lon !== lon) return null;
  const kn = parseNum(parts[7]);
  let magvar = NaN;
  if (parts.length >= 12) {
    const mv = parseNum(parts[10]);
    if (mv === mv) magvar = parts[11] === "E" ? mv : -mv;
  }
  return {
    key: tm,
    t: epochFromCivil(year, mo, dd, hh, mi, ss === 60 ? 59 : ss),
    lat, lon,
    speed: kn === kn ? kn * KNOTS_TO_KMH : NaN,
    track: parseNum(parts[8]),
    magvar,
  };
}

function gga(parts) {
  if (parts.length < 10) return null;
  return { key: parts[1], alt: parseNum(parts[9]) };
}

async function* buffers(reader, opts) {
  if (await looksLikeMp4(reader)) {
    const cap = opts.tailCap > 0 ? opts.tailCap : 1024 * 1024;
    for await (const a of iterAtoms(reader)) {
      if (ATOMS.has(a.type) && a.bodySize > 0 && a.bodySize <= cap) {
        yield await reader.readRange(a.body, a.end);
      }
    }
    return;
  }
  const [stride, off] = await detectAlignment(reader);
  if (stride) {
    let end = reader.size();
    if (opts.scanCap > 0 && opts.scanCap < end) end = opts.scanCap;
    for await (const [, payload] of
        iterPes(reader, stride, off, WELL_KNOWN_PIDS, opts.chunk, true, 65536, end)) {
      yield payload;
    }
    return;
  }
  if (opts.rawNmea) {
    for (const [start, stop] of cappedWindows(reader.size(), opts.scanCap)) {
      for await (const [slab] of scanChunks(reader, opts.chunk, opts.overlap, start, stop)) {
        yield slab.data;
      }
    }
  }
}

async function collect(reader, opts, limit = 0) {
  let pendRmc = null;
  let pendGga = null;
  let pendKey = null;
  let rejects = 0;
  let seen = 0;
  const out = [];
  const flush = () => {
    if (pendRmc === null) return;
    const alt = pendGga !== null ? pendGga.alt : NaN;
    out.push(new Point(pendRmc.t, pendRmc.lat, pendRmc.lon, pendRmc.speed, pendRmc.track,
      alt, pendRmc.magvar, NaN, NaN, NaN, -1, 0));
  };
  for await (const buf of buffers(reader, opts)) {
    for (const [kind, parts, ok] of iterSentences(buf)) {
      const t = kind.slice(2, 5);
      if (t !== "RMC" && t !== "GGA") continue;
      if (!ok) { rejects += 1; continue; }
      seen += 1;
      const key = parts.length > 1 ? parts[1] : "";
      // Pairing is on the NMEA time field, not on line order. spec 04
      if (pendKey !== null && key !== pendKey) {
        flush();
        pendRmc = null;
        pendGga = null;
      }
      pendKey = key;
      if (t === "RMC") {
        const r = rmc(parts);
        if (r !== null) pendRmc = r;
      } else {
        const g = gga(parts);
        if (g !== null) pendGga = g;
      }
      if (limit && out.length >= limit) return [out, seen, rejects];
    }
  }
  flush();
  return [out, seen, rejects];
}

export async function sniff(reader, opts) {
  if (!opts.deep) return 0.0;
  const [pts] = await collect(reader, opts, 1);
  return pts.length ? 0.7 : 0.0;
}

export async function parse(reader, opts) {
  const res = new ParseResult(FORMAT_ID, STATUS, [reader.name], [], {}, [], 0, false);
  const [pts, seen, rejects] = await collect(reader, opts);
  res.meta.sentences = seen;
  res.meta.checksum_rejects = rejects;
  if (rejects) res.warn(rejects + " NMEA sentences failed their checksum and were ignored");
  if (!pts.length) {
    if (seen) throw new ParseError("NMEA sentences found but none carried a valid RMC fix");
    throw new ParseError("no NMEA sentences found");
  }
  res.points = pts;
  return res;
}

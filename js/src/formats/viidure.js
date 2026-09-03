// Viidure / INNOVV ASCII records in a TS private stream. spec/03-viidure.md
// Mirrors python/src/dashgps/formats/viidure.py
//
// Status: UNTESTED. Written from a record published in a public bug report.

import { detectAlignment, iterPes } from "../containers/ts.js";
import { ascii, indexOfBytes } from "../io.js";
import { _coord as coord, dateParts, splitTokens, timeParts } from "../ligo_record.js";
import { epochFromCivil, parseNum } from "../fmt.js";
import { ParseError, ParseResult, Point } from "../model.js";

export const FORMAT_ID = "viidure";
export const STATUS = "untested";

const MAGIC = ascii("Viidure");
const PID = 0x0300;

function parseText(text) {
  const toks = splitTokens(text);
  if (toks.length < 6) return null;
  const dp = dateParts(toks[0]);
  const tp = timeParts(toks[1]);
  if (dp === null || tp === null) return null;
  const lat = coord(toks[2], "N", "S");
  const lon = coord(toks[3], "E", "W");
  if (lat === null || lon === null || toks[5] !== "km/h") return null;
  const out = {
    t: epochFromCivil(dp[0], dp[1], dp[2], tp[0], tp[1], tp[2]),
    lat, lon, speed: parseNum(toks[4]),
    heading: NaN, alt: NaN, ax: NaN, ay: NaN, az: NaN,
  };
  let unknown = null;
  const bare = [];
  for (let i = 6; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.length >= 3 && tok[1] === ":") {
      const v = parseNum(tok.slice(2));
      if (tok[0] === "x") out.ax = v;
      else if (tok[0] === "y") out.ay = v;
      else if (tok[0] === "z") out.az = v;
    } else {
      bare.push(parseNum(tok));
    }
  }
  // After km/h the published sample carries: track, altitude, then an unknown constant.
  if (bare.length >= 1) out.heading = bare[0];
  if (bare.length >= 2) out.alt = bare[1];
  if (bare.length >= 3) unknown = bare[2];
  if (out.lat === 0 && out.lon === 0) return null;
  return [out, unknown];
}

async function* iterRecords(reader, opts) {
  const [stride, off] = await detectAlignment(reader);
  if (stride === 0) return;
  // GPS in a TS private stream is interleaved throughout, so the head of the file is
  // representative: if the stream is there at all, it is in the first scanCap bytes.
  let end = reader.size();
  if (opts.scanCap > 0 && opts.scanCap < end) end = opts.scanCap;
  for await (const [, payload] of iterPes(reader, stride, off, [PID], opts.chunk, true, 65536, end)) {
    let p = 0;
    for (;;) {
      const hit = indexOfBytes(payload, MAGIC, p, payload.length);
      if (hit < 0) break;
      const start = hit + MAGIC.length;
      let stop = payload.length;
      for (let i = start; i < payload.length; i++) {
        if (payload[i] === 0) { stop = i; break; }
      }
      const nxt = indexOfBytes(payload, MAGIC, start, payload.length);
      if (nxt >= 0 && nxt < stop) stop = nxt;
      let text = "";
      for (let i = start; i < stop; i++) text += String.fromCharCode(payload[i]);
      yield text;
      p = start;
    }
  }
}

export async function sniff(reader, opts) {
  if (!opts.deep) return 0.0;
  for await (const text of iterRecords(reader, opts)) {
    return parseText(text) !== null ? 0.85 : 0.0;
  }
  return 0.0;
}

export async function parse(reader, opts) {
  const res = new ParseResult(FORMAT_ID, STATUS, [reader.name]);
  const tz = opts.tzOffsetS;
  const unknowns = [];
  let n = 0;
  for await (const text of iterRecords(reader, opts)) {
    n += 1;
    const got = parseText(text);
    if (got === null) { res.warn("unparsable Viidure record"); continue; }
    const [f, unknown] = got;
    if (unknown !== null && unknown === unknown && unknowns.indexOf(unknown) < 0) {
      unknowns.push(unknown);
    }
    res.points.push(new Point(f.t - tz, f.lat, f.lon, f.speed, f.heading, f.alt, NaN,
      f.ax, f.ay, f.az, -1, 0));
  }
  if (n === 0) throw new ParseError("no Viidure records found");
  res.meta.records = n;
  res.meta.unknown_field_values = unknowns;
  return res;
}

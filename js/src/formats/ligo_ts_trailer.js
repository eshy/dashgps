// LigoGPS trailer appended after the last TS packet. spec/01-ligogps-ts-trailer.md
// Clause numbers refer to §1.6. Mirrors python/src/dashgps/formats/ligo_ts_trailer.py
//
// Status: VERIFIED against ~1,230 real ICESKY files.

import { ascii, bytesEqual, readSlab } from "../io.js";
import {
  LIGO_MAGIC, detectStride, isAsciiRegion, isDateShape, parseLigoText, recordText,
} from "../ligo_record.js";
import { ParseError, ParseResult, Point } from "../model.js";

export const FORMAT_ID = "ligo.ts_trailer";
export const STATUS = "verified";

const END_MAGICS = [ascii("####"), ascii("&&&&")];
const TAG_UPPER = ascii("SKIP");
const TAG_LOWER = ascii("skip");
const FOOTER_PROBE = 65536; // one read covers a typical whole trailer
const MAX_BLOCKS = 256;

function isTag(b) { return bytesEqual(b, TAG_UPPER) || bytesEqual(b, TAG_LOWER); }

function memo(opts, value) {
  if (opts) opts.probe["ligo.footer"] = value;
  return value;
}

// Clause 1. Memoized on opts.probe: sniff and parse both need the footer, and on a network
// filesystem a second round trip per file is the difference between seconds and minutes.
async function footer(reader, opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts.probe, "ligo.footer")) {
    return opts.probe["ligo.footer"];
  }
  const n = reader.size();
  if (n < 32) return memo(opts, null);
  const slab = await readSlab(reader, n > FOOTER_PROBE ? n - FOOTER_PROBE : 0, n);
  if (!slab.covers(n - 8, 8)) return memo(opts, null);
  const magic = slab.bytes(n - 8, 4);
  let ok = false;
  for (const m of END_MAGICS) if (bytesEqual(magic, m)) ok = true;
  if (!ok) return memo(opts, null);
  const length = slab.u32be(n - 4);
  if (length < 8 || length > n) return memo(opts, null);
  let magicStr = "";
  for (const b of magic) magicStr += String.fromCharCode(b);
  return memo(opts, { slab, length, magic: magicStr });
}

export async function sniff(reader, opts) {
  return (await footer(reader, opts)) !== null ? 0.95 : 0.0;
}

// Clause 3
function readHeader(slab, off, trEnd) {
  if (off + 8 > trEnd || !slab.covers(off, 8)) return null;
  if (!isTag(slab.bytes(off + 4, 4))) return null;
  return slab.u32be(off);
}

function resync(slab, after, trEnd, trStart, res) {
  let p = after;
  for (;;) {
    const a = slab.find(TAG_UPPER, p, trEnd);
    const b = slab.find(TAG_LOWER, p, trEnd);
    let hit;
    if (a < 0) hit = b;
    else if (b < 0) hit = a;
    else hit = a < b ? a : b;
    if (hit < 0) return -1;
    const start = hit - 4;
    if (start >= slab.base && readHeader(slab, start, trEnd) !== null) {
      const sz = slab.u32be(start);
      if (sz >= 8 && sz <= trEnd - start + 8) {
        // Offset from the start of the trailer: stable regardless of how much of the
        // file the reader happened to buffer.
        res.warn("resynchronised to block header at trailer+" + (start - trStart));
        return start;
      }
    }
    p = hit + 4;
  }
}

export async function parse(reader, opts) {
  const res = new ParseResult(FORMAT_ID, STATUS, [reader.name]);
  const n = reader.size();

  const f = await footer(reader, opts);
  if (f === null) throw new ParseError("no LigoGPS trailer footer");
  res.meta.end_magic = f.magic;
  res.meta.trailer_len = f.length;

  // Clause 2. Reuse the footer probe when the whole trailer already fits inside it.
  const trStart = n - f.length;
  let readFrom = trStart;
  if (f.length > opts.tailCap) {
    readFrom = n - opts.tailCap;
    res.warn("trailer is " + f.length + " bytes, larger than the " + opts.tailCap +
             "-byte cap; parsing the tail only");
  }
  const slab = f.slab.base <= readFrom ? f.slab : await readSlab(reader, readFrom, n);
  const trEnd = n - 8;

  // Clause 3
  const blocks = [];
  let pos = trStart >= slab.base ? trStart : slab.base;
  let guard = 0;
  while (pos + 8 <= trEnd && guard < MAX_BLOCKS) {
    guard += 1;
    const sz = readHeader(slab, pos, trEnd);
    if (sz === null) {
      pos = resync(slab, pos + 1, trEnd, trStart, res);
      if (pos < 0) break;
      continue;
    }
    let nxt = -1;
    for (const cand of [pos + sz, pos + sz + 8]) {
      if (cand <= pos) continue;
      if (cand >= trEnd) { nxt = trEnd; break; }
      if (readHeader(slab, cand, trEnd) !== null) { nxt = cand; break; }
    }
    if (nxt < 0) {
      const r = resync(slab, pos + 8, trEnd, trStart, res);
      nxt = r > pos ? r : trEnd;
    }
    blocks.push([pos, nxt]);
    pos = nxt;
  }
  res.meta.blocks = blocks.length;

  // Clauses 4 and 5: keep the last block that holds ASCII GPS records.
  let chosen = null;
  for (const [start, end] of blocks) {
    const lig = start + 8;
    if (!slab.covers(lig, LIGO_MAGIC.length)) continue;
    if (!bytesEqual(slab.bytes(lig, LIGO_MAGIC.length), LIGO_MAGIC)) continue;
    const first = lig + 0x14;
    // The record body starts after the 4-byte binary index, so the ASCII test starts there.
    if (!isAsciiRegion(slab, first + 4, 96)) continue;
    if (!isDateShape(slab, first + 4)) continue;
    chosen = [lig, first, end];
  }
  if (chosen === null) throw new ParseError("trailer has no ASCII LIGOGPSINFO block");
  const [lig, first, blockEnd] = chosen;

  res.meta.variant = slab.covers(lig + 0x0b, 1) ? slab.u8(lig + 0x0b) : -1;
  const countField = slab.covers(lig + 0x10, 4) ? slab.u32be(lig + 0x10) : 0;
  res.meta.count_field = countField;

  // Clause 6
  const [stride, warn] = detectStride(slab, first, blockEnd);
  if (warn) res.warn(warn);
  if (stride <= 0) throw new ParseError("could not determine record stride");
  res.meta.stride = stride;

  // Clause 7
  let derived = Math.floor((blockEnd - first) / stride);
  if (derived < 0) derived = 0;
  let count = countField > 0 ? countField : derived;
  if (count > derived) {
    if (countField > 0) {
      res.warn("record count field says " + countField + " but only " + derived +
               " records fit; using " + derived);
    }
    count = derived;
  } else if (countField > 0 && derived - countField > 1) {
    res.warn("record count field says " + countField + " but " + derived + " records fit");
  }
  res.meta.records = count;

  // Clause 8
  const tz = opts.tzOffsetS;
  let dropped = 0;
  for (let i = 0; i < count; i++) {
    const off = first + i * stride;
    const idx = slab.covers(off, 4) ? slab.u32be(off) : -1;
    const text = recordText(slab, off, stride);
    if (!text) continue;
    const fields = parseLigoText(text);
    if (fields === null) { res.warn("unparsable record at index " + i); continue; }
    if (fields.nofix) { dropped += 1; continue; }
    res.points.push(new Point(fields.t - tz, fields.lat, fields.lon, fields.speedKmh,
      fields.headingDeg, fields.altM, fields.magvarDeg, fields.ax, fields.ay, fields.az, idx, 0));
  }
  res.droppedNofix = dropped;
  return res;
}

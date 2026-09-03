// LigoGPS plaintext records without the trailer wrapper. spec/02-ligogps-plaintext.md
// Mirrors python/src/dashgps/formats/ligo_plain.py

import { iterAtoms, looksLikeMp4 } from "../containers/mp4.js";
import { bytesEqual, cappedWindows, readSlab, scanChunks } from "../io.js";
import {
  LIGO_MAGIC, detectStride, isAsciiRegion, isDateShape, parseLigoText, recordText,
} from "../ligo_record.js";
import { ParseError, ParseResult, Point } from "../model.js";

export const FORMAT_ID = "ligo.plain";
export const STATUS = "reverse-engineered";

const ATOMS = new Set(["skip", "free", "udta", "gps "]);

async function findInMp4(reader) {
  if (!(await looksLikeMp4(reader))) return null;
  let found = null;
  for await (const a of iterAtoms(reader)) {
    if (!ATOMS.has(a.type) || a.bodySize < 0x20) continue;
    const probe = await readSlab(reader, a.body, a.body + LIGO_MAGIC.length);
    if (probe.length < LIGO_MAGIC.length) continue;
    if (!bytesEqual(probe.bytes(a.body, LIGO_MAGIC.length), LIGO_MAGIC)) continue;
    found = [a.body, a.end];
  }
  return found;
}

async function findInScan(reader, opts) {
  let found = null;
  for (const [start, end] of cappedWindows(reader.size(), opts.scanCap)) {
    for await (const [slab, first] of scanChunks(reader, opts.chunk, opts.overlap, start, end)) {
      let p = slab.base;
      for (;;) {
        const hit = slab.find(LIGO_MAGIC, p, slab.end);
        if (hit < 0) break;
        if (first || hit >= slab.base + opts.overlap) found = [hit, reader.size()];
        p = hit + 1;
      }
    }
  }
  return found;
}

async function locate(reader, opts) {
  const hit = await findInMp4(reader);
  if (hit !== null) return [hit, "mp4"];
  if (opts.deep) {
    const s = await findInScan(reader, opts);
    if (s !== null) return [s, "scan"];
  }
  return [null, null];
}

export async function sniff(reader, opts) {
  // Cheap path first: an MP4 atom walk is a few dozen small reads.
  if ((await findInMp4(reader)) !== null) return 0.9;
  if (!opts.deep) return 0.0;
  return (await findInScan(reader, opts)) !== null ? 0.6 : 0.0;
}

export async function parse(reader, opts) {
  const res = new ParseResult(FORMAT_ID, STATUS, [reader.name]);
  const [hit, how] = await locate(reader, opts);
  if (hit === null) throw new ParseError("no LIGOGPSINFO header found");
  const lig = hit[0];
  let blockEnd = hit[1];
  res.meta.found_in = how;

  const cap = opts.tailCap > 0 ? opts.tailCap : 1024 * 1024;
  if (blockEnd - lig > cap) {
    blockEnd = lig + cap;
    res.warn("LIGOGPSINFO block larger than the read cap; parsing the first " + cap + " bytes");
  }
  const slab = await readSlab(reader, lig, blockEnd);
  const first = lig + 0x14;
  if (!isAsciiRegion(slab, first + 4, 96) || !isDateShape(slab, first + 4)) {
    throw new ParseError("LIGOGPSINFO block does not hold ASCII records");
  }

  res.meta.variant = slab.covers(lig + 0x0b, 1) ? slab.u8(lig + 0x0b) : -1;
  const countField = slab.covers(lig + 0x10, 4) ? slab.u32be(lig + 0x10) : 0;
  res.meta.count_field = countField;

  const [stride, warn] = detectStride(slab, first, slab.end);
  if (warn) res.warn(warn);
  if (stride <= 0) throw new ParseError("could not determine record stride");
  res.meta.stride = stride;

  const derived = Math.floor((slab.end - first) / stride);
  const count = countField > 0 && countField <= derived ? countField : derived;
  res.meta.records = count;

  const tz = opts.tzOffsetS;
  let dropped = 0;
  for (let i = 0; i < count; i++) {
    const off = first + i * stride;
    const idx = slab.covers(off, 4) ? slab.u32be(off) : -1;
    const text = recordText(slab, off, stride);
    if (!text) continue;
    const f = parseLigoText(text);
    if (f === null) { res.warn("unparsable record at index " + i); continue; }
    if (f.nofix) { dropped += 1; continue; }
    res.points.push(new Point(f.t - tz, f.lat, f.lon, f.speedKmh, f.headingDeg, f.altM,
      f.magvarDeg, f.ax, f.ay, f.az, idx, 0));
  }
  res.droppedNofix = dropped;
  return res;
}

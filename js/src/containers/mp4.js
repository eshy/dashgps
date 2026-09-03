// Lazy ISO-BMFF atom walking. spec/10-containers.md §10.2
// Mirrors python/src/dashgps/containers/mp4.py

import { readSlab } from "../io.js";

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "moof", "traf", "mvex"]);
const FTYP_BRANDS = new Set(["ftyp", "styp", "moov", "free", "skip", "mdat", "wide", "pnot"]);

export class Atom {
  constructor(type, start, body, end, path) {
    this.type = type;
    this.start = start;
    this.body = body;
    this.end = end;
    this.path = path;
  }
  get bodySize() { return this.end - this.body; }
}

function typeStr(b, i) {
  return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
}

export async function looksLikeMp4(reader) {
  const n = reader.size();
  if (n < 16) return false;
  const head = await reader.readRange(0, 16);
  if (head.length < 16) return false;
  const size = ((head[0] << 24) >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
  if (!FTYP_BRANDS.has(typeStr(head, 4))) return false;
  return size === 0 || size === 1 || (size >= 8 && size <= n);
}

export async function* iterAtoms(reader, start = 0, end, path = "", depth = 0,
                                 maxDepth = 6, maxAtoms = 4096) {
  const n = end === undefined ? reader.size() : end;
  let pos = start;
  let count = 0;
  while (pos + 8 <= n && count < maxAtoms) {
    const hdr = await readSlab(reader, pos, pos + 16);
    if (hdr.length < 8) return;
    let size = hdr.u32be(pos);
    const t = typeStr(hdr.data, 4);
    let body = pos + 8;
    if (size === 1) {
      if (hdr.length < 16) return;
      size = hdr.u64be(pos + 8);
      body = pos + 16;
    } else if (size === 0) {
      size = n - pos;
    }
    if (size < body - pos || pos + size > n) return;
    const aend = pos + size;
    const a = new Atom(t, pos, body, aend, path + "/" + t);
    yield a;
    count += 1;
    if (CONTAINERS.has(t) && depth < maxDepth) {
      yield* iterAtoms(reader, body, aend, a.path, depth + 1, maxDepth, maxAtoms);
    }
    pos = aend;
  }
}

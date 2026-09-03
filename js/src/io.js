// Reader abstraction and byte-slab helpers. spec/00-model.md
// Mirrors python/src/dashgps/io.py. The only structural difference between the two cores is that
// readRange is async here, so parsers are async too.

export class BytesReader {
  constructor(data, name = "<bytes>") {
    this._d = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.name = name;
  }
  size() { return this._d.length; }
  async readRange(start, end) {
    if (start < 0) start = 0;
    if (end > this._d.length) end = this._d.length;
    if (end <= start) return new Uint8Array(0);
    return this._d.subarray(start, end);
  }
}

// Reads a browser File/Blob. Blob.slice does not touch the disk until the slice is read, which is
// what lets a 1 GB clip cost ~50 KB.
export class BlobReader {
  constructor(blob, name) {
    this._b = blob;
    this.name = name || blob.name || "<blob>";
  }
  size() { return this._b.size; }
  async readRange(start, end) {
    if (start < 0) start = 0;
    if (end > this._b.size) end = this._b.size;
    if (end <= start) return new Uint8Array(0);
    return new Uint8Array(await this._b.slice(start, end).arrayBuffer());
  }
}

export class CountingReader {
  constructor(inner) {
    this._r = inner;
    this.name = inner.name;
    this.ranges = [];
    this.bytesRead = 0;
  }
  size() { return this._r.size(); }
  async readRange(start, end) {
    const b = await this._r.readRange(start, end);
    this.ranges.push([start, end]);
    this.bytesRead += b.length;
    return b;
  }
}

const DEC = new TextDecoder("ascii", { fatal: false });

export class Slab {
  constructor(base, data) {
    this.base = base;
    this.data = data;
  }
  get length() { return this.data.length; }
  get end() { return this.base + this.data.length; }
  covers(off, n = 1) { return off >= this.base && off + n <= this.end; }
  u8(off) { return this.data[off - this.base]; }
  u16be(off) {
    const i = off - this.base;
    return (this.data[i] << 8) | this.data[i + 1];
  }
  u32be(off) {
    const i = off - this.base;
    const d = this.data;
    return ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];
  }
  u64be(off) { return this.u32be(off) * 4294967296 + this.u32be(off + 4); }
  bytes(off, n) {
    const i = off - this.base;
    return this.data.subarray(i, i + n);
  }
  ascii(off, n) { return DEC.decode(this.bytes(off, n)); }
  find(needle, start, end) {
    const from = Math.max(0, start - this.base);
    const to = end === undefined ? this.data.length : end - this.base;
    const i = indexOfBytes(this.data, needle, from, to);
    return i < 0 ? -1 : i + this.base;
  }
}

export function indexOfBytes(hay, needle, from, to) {
  const n = needle.length;
  const limit = (to === undefined ? hay.length : Math.min(to, hay.length)) - n;
  outer: for (let i = Math.max(0, from); i <= limit; i++) {
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function ascii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export async function readSlab(reader, start, end) {
  if (start < 0) start = 0;
  const n = reader.size();
  if (end > n) end = n;
  if (end < start) end = start;
  return new Slab(start, await reader.readRange(start, end));
}

// Byte ranges a full-scan format may read: the head, and the tail when they do not overlap.
// Without this bound, one clip that matches nothing costs a whole pass over a gigabyte for
// every full-scan format in the registry.
export function cappedWindows(size, cap) {
  if (cap <= 0 || size <= cap) return [[0, size]];
  if (size <= 2 * cap) return [[0, size]];
  return [[0, cap], [size - cap, size]];
}

// Overlapping slabs. Overlap is mandatory: records and NMEA sentences straddle boundaries.
// spec/10-containers.md §10.3
export async function* scanChunks(reader, chunk = 4 * 1024 * 1024, overlap = 4096, start = 0, end) {
  const n = reader.size();
  if (end === undefined || end > n) end = n;
  let pos = start;
  let first = true;
  while (pos < end) {
    let stop = pos + chunk;
    if (stop > end) stop = end;
    yield [new Slab(pos, await reader.readRange(pos, stop)), first];
    if (stop >= end) break;
    pos = stop - overlap;
    if (pos <= 0) pos = stop;
    first = false;
  }
}

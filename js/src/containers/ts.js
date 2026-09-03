// MPEG-TS packet and PES walking. spec/10-containers.md §10.1
// Mirrors python/src/dashgps/containers/ts.py

const SYNC = 0x47;
const STRIDES = [188, 192, 204];
const MIN_HITS = 3;
const CONFIRM_HITS = 20;

// Dashcams routinely omit their GPS program from the PMT, so we scan PIDs directly. spec 10.1
export const WELL_KNOWN_PIDS = [0x0300, 0x0102, 0x01e4, 0x0e1b];

const NO_SYNTAX = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

export async function detectAlignment(reader, limit = 65536) {
  const n = reader.size();
  const head = await reader.readRange(0, limit < n ? limit : n);
  let best = [0, 0, 0];
  for (const stride of STRIDES) {
    for (let off = 0; off < stride; off++) {
      if (off >= head.length) break;
      if (head[off] !== SYNC) continue;
      const avail = Math.ceil((head.length - off) / stride);
      const want = avail > CONFIRM_HITS ? CONFIRM_HITS : avail;
      let hits = 0;
      for (let p = off; p < head.length; p += stride) {
        if (head[p] !== SYNC) break;
        hits += 1;
      }
      if (hits >= MIN_HITS && hits >= want && hits > best[2]) {
        best = [stride, off, hits];
        if (hits >= CONFIRM_HITS) return [stride, off];
      }
    }
  }
  return best[0] ? [best[0], best[1]] : [0, 0];
}

export async function* iterPackets(reader, stride, offset, pids, chunk = 4 * 1024 * 1024, end) {
  const n = end === undefined ? reader.size() : end;
  const per = Math.max(1, Math.floor(chunk / stride));
  const step = per * stride;
  const want = new Set(pids);
  let pos = offset;
  while (pos + stride <= n) {
    let stop = pos + step;
    if (stop > n) stop = n;
    const buf = await reader.readRange(pos, stop);
    for (let i = 0; i + stride <= buf.length; i += stride) {
      if (buf[i] !== SYNC) continue;
      const b1 = buf[i + 1];
      const pid = ((b1 & 0x1f) << 8) | buf[i + 2];
      if (!want.has(pid)) continue;
      const b3 = buf[i + 3];
      if (!(b3 & 0x10)) continue;
      let j = i + 4;
      if (b3 & 0x20) j += 1 + buf[j];
      if (j < i + 188) yield [pid, (b1 & 0x40) !== 0, buf.subarray(j, i + 188)];
    }
    if (stop >= n) break;
    const advanced = Math.floor(buf.length / stride) * stride;
    pos = advanced > 0 ? pos + advanced : stop;
  }
}

export function stripPesHeader(payload) {
  if (payload.length >= 6 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
    const sid = payload[3];
    if (NO_SYNTAX.has(sid)) return payload.subarray(6);
    if (payload.length >= 9) return payload.subarray(9 + payload[8]);
    return new Uint8Array(0);
  }
  return payload;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Some cameras never set payload_unit_start_indicator on their GPS PID, so payloads accumulate
// regardless when tolerateNoPusi is set. spec 10.1
export async function* iterPes(reader, stride, offset, pids, chunk = 4 * 1024 * 1024,
                               tolerateNoPusi = true, cap = 65536, end) {
  const bufs = new Map();
  const lens = new Map();
  const seen = new Map();
  for await (const [pid, pusi, payload] of
      iterPackets(reader, stride, offset, pids, chunk, end)) {
    if (pusi) {
      seen.set(pid, true);
      const prev = bufs.get(pid);
      if (prev && prev.length) yield [pid, stripPesHeader(concat(prev, lens.get(pid)))];
      bufs.set(pid, [payload]);
      lens.set(pid, payload.length);
    } else {
      let cur = bufs.get(pid);
      if (cur === undefined) {
        if (!tolerateNoPusi && !seen.get(pid)) continue;
        cur = [];
        bufs.set(pid, cur);
        lens.set(pid, 0);
      }
      if (lens.get(pid) < cap) {
        cur.push(payload);
        lens.set(pid, lens.get(pid) + payload.length);
      }
    }
  }
  for (const [pid, chunks] of bufs) {
    if (chunks.length) yield [pid, stripPesHeader(concat(chunks, lens.get(pid)))];
  }
}

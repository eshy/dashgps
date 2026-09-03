// Dependency-free stored-ZIP writer. spec/21-outputs.md
// Mirrors python/src/dashgps/writers/zipw.py
//
// Fixed DOS timestamp so archives are byte-reproducible and can be diffed by the parity gate.

const DOS_TIME = 0x0000; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01
const MAX_SIZE = 0xffffffff;

let TABLE = null;
function table() {
  if (TABLE === null) {
    TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      TABLE[i] = c >>> 0;
    }
  }
  return TABLE;
}

export function crc32(data) {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

const ENC = new TextEncoder();

// members: [[name, Uint8Array], ...]
export function build(members) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of members) {
    const nb = ENC.encode(name);
    const c = crc32(data);
    const n = data.length;
    if (n > MAX_SIZE || offset > MAX_SIZE) {
      throw new Error("zip member or archive exceeds 4 GiB; ZIP64 is not supported");
    }
    const local = Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(c), ...u32(n), ...u32(n),
      ...u16(nb.length), ...u16(0), ...nb,
    ]);
    parts.push(local, data);
    central.push(Uint8Array.from([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(c), ...u32(n), ...u32(n),
      ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...nb,
    ]));
    offset += local.length + n;
  }
  let cdLen = 0;
  for (const c of central) cdLen += c.length;
  const eocd = Uint8Array.from([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(members.length), ...u16(members.length),
    ...u32(cdLen), ...u32(offset), ...u16(0),
  ]);
  let total = 0;
  for (const p of parts) total += p.length;
  total += cdLen + eocd.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (const c of central) { out.set(c, o); o += c.length; }
  out.set(eocd, o);
  return out;
}

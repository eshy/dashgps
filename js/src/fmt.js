// Deterministic formatting primitives. spec/30-formatting.md
//
// This file is the byte-identical twin of python/src/dashgps/fmt.py. Keep the two in step
// function-for-function; CI diffs their output over the whole fixture set.
//
// Never use toFixed, toPrecision, JSON.stringify, Date, Math.round or Array.prototype.sort's
// default comparator anywhere that reaches output. See spec/30-formatting.md for why.

export const NAN = NaN;

// A table rather than Math.pow, so Python and JavaScript multiply by bit-identical constants.
const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];
const MAX_EXACT = 9007199254740992; // 2**53

export const P_LATLON = 6;
export const P_ALT = 1;
export const P_SPEED = 2;
export const P_ANGLE = 1;
export const P_ACCEL = 3;
export const P_DT = 3;
export const P_DIST = 3;
export const P_DUR = 3;

export const EARTH_R_M = 6371008.8; // IUGG mean radius, spec 20.4

export function isNan(x) {
  return x === null || x === undefined || x !== x;
}

// spec 30.1
export function fixed(x, n) {
  if (x === null || x === undefined || x !== x) return "";
  if (x === Infinity || x === -Infinity) return "";
  const neg = x < 0;
  const y = (neg ? -x : x) * POW10[n];
  if (y >= MAX_EXACT) return "";
  let i = Math.floor(y);
  if (y - i >= 0.5) i += 1;
  let s = String(i);
  if (n > 0) {
    if (s.length < n + 1) s = "0".repeat(n + 1 - s.length) + s;
    s = s.slice(0, s.length - n) + "." + s.slice(s.length - n);
  }
  if (neg) {
    for (const ch of s) {
      if (ch !== "0" && ch !== ".") return "-" + s;
    }
  }
  return s;
}

export function zpad(v, width) {
  let s = String(v);
  if (s.length < width) s = "0".repeat(width - s.length) + s;
  return s;
}

// Integer floor division; `a / b | 0` truncates toward zero and breaks on dates before 1970.
function fdiv(a, b) {
  return Math.floor(a / b);
}

// spec 30.2 - Hinnant's civil-date algorithms, integers only.
export function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = fdiv(y, 400);
  const yoe = y - era * 400;
  const doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z) {
  z += 719468;
  const era = fdiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100));
  const mp = fdiv(5 * doy + 2, 153);
  const d = doy - fdiv(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

export function epochFromCivil(y, mo, d, h, mi, s) {
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
}

export function isoLocal(t) {
  if (t === null || t === undefined || t !== t) return "";
  const days = Math.floor(t / 86400);
  let secs = Math.floor(t - days * 86400);
  if (secs < 0) secs = 0;
  else if (secs > 86399) secs = 86399;
  const [y, mo, d] = civilFromDays(days);
  return (
    zpad(y, 4) + "-" + zpad(mo, 2) + "-" + zpad(d, 2) + "T" +
    zpad(Math.floor(secs / 3600), 2) + ":" +
    zpad(Math.floor(secs / 60) % 60, 2) + ":" + zpad(secs % 60, 2)
  );
}

export function isoZ(t) {
  const s = isoLocal(t);
  return s ? s + "Z" : "";
}

export function dateLocal(t) {
  const s = isoLocal(t);
  return s ? s.slice(0, 10) : "";
}

const JSON_ESC = {
  8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\",
};

export function zpadHex(c) {
  const h = "0123456789abcdef";
  return h[(c >> 12) & 15] + h[(c >> 8) & 15] + h[(c >> 4) & 15] + h[c & 15];
}

// spec 30.3
export function jsonStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const e = JSON_ESC[c];
    if (e !== undefined) out += e;
    else if (c < 0x20) out += "\\u" + zpadHex(c);
    else out += ch;
  }
  return out + '"';
}

const ENC = new TextEncoder();

// spec 30.4 - order by UTF-8 bytes, so Python and JavaScript agree above the BMP.
export function byteKey(s) {
  return ENC.encode(s);
}

export function cmpBytes(a, b) {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function cmpNames(a, b) {
  return cmpBytes(byteKey(a), byteKey(b));
}

export function sortByName(arr, key = (x) => x) {
  return arr.sort((a, b) => cmpNames(key(a), key(b)));
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dlat = (lat2 - lat1) * rad;
  const dlon = (lon2 - lon1) * rad;
  const sdlat = Math.sin(dlat / 2);
  const sdlon = Math.sin(dlon / 2);
  let a = sdlat * sdlat + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * sdlon * sdlon;
  if (a < 0) a = 0;
  else if (a > 1) a = 1;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(a));
}

// spec 01 §1.7 - validate, then convert. Both languages are correctly rounded, so the resulting
// doubles are bit-identical.
export function parseNum(tok) {
  if (!tok) return NaN;
  let i = 0;
  const n = tok.length;
  const c0 = tok[0];
  if (c0 === "-" || c0 === "+") i = 1;
  let digits = 0;
  let dot = 0;
  for (; i < n; i++) {
    const c = tok[i];
    if (c >= "0" && c <= "9") digits += 1;
    else if (c === ".") {
      dot += 1;
      if (dot > 1) return NaN;
    } else return NaN;
  }
  if (digits === 0) return NaN;
  const v = Number(tok);
  return v !== v ? NaN : v;
}

export function csvCell(v) {
  if (v.indexOf(",") >= 0 || v.indexOf('"') >= 0 || v.indexOf("\n") >= 0 || v.indexOf("\r") >= 0) {
    return '"' + v.split('"').join('""') + '"';
  }
  return v;
}

export function xmlText(s) {
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;");
}

// Tiny deterministic JSON emitter for metadata. Object key order is insertion order, matching
// Python dict semantics for string keys. spec 30.3
export function jsonValue(v, indent = 0) {
  const pad = "  ".repeat(indent);
  const pad2 = "  ".repeat(indent + 1);
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return jsonStr(v);
  if (typeof v === "number") {
    if (v !== v || v === Infinity || v === -Infinity) return "null";
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    return fixed(v, 6);
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((x) => pad2 + jsonValue(x, indent + 1));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    const items = keys.map((k) => pad2 + jsonStr(String(k)) + ": " + jsonValue(v[k], indent + 1));
    return "{\n" + items.join(",\n") + "\n" + pad + "}";
  }
  return jsonStr(String(v));
}

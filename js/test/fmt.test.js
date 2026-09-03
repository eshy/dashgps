// Mirrors python/tests/test_fmt.py. The same vectors, asserted in both languages: if these ever
// disagree, output parity is already broken. spec/30-formatting.md

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fmt from "../src/fmt.js";

const FIXED_VECTORS = [
  [0.0, 6, "0.000000"],
  [-0.0, 6, "0.000000"],
  [25.774430, 6, "25.774430"],
  [-80.137840, 6, "-80.137840"],
  [1.0, 0, "1"],
  [0.5, 0, "1"],          // half-up, not banker's
  [1.5, 0, "2"],
  [2.5, 0, "3"],
  [-0.5, 0, "-1"],
  [-1.5, 0, "-2"],
  [0.0000001, 6, "0.000000"],
  [-0.0000001, 6, "0.000000"],
  [-0.0000005, 6, "-0.000001"],
  [123.456, 2, "123.46"],
  [123.454, 2, "123.45"],
  [1e15, 3, ""],
  [Infinity, 2, ""],
  [-Infinity, 2, ""],
  [NaN, 2, ""],
  [null, 2, ""],
  [9.999, 2, "10.00"],
  [-9.999, 2, "-10.00"],
  [0.001, 3, "0.001"],
  [-0.0004, 3, "0.000"],
];

const CIVIL_VECTORS = [
  [1970, 1, 1, 0],
  [1969, 12, 31, -1],
  [2000, 3, 1, 11017],
  [2026, 8, 3, 20668],
  [1900, 1, 1, -25567],
  [2200, 12, 31, 84370],
];

const ISO_VECTORS = [
  [0.0, "1970-01-01T00:00:00"],
  [1785750858.0, "2026-08-03T09:54:18"],
  [-1.0, "1969-12-31T23:59:59"],
  [86399.0, "1970-01-01T23:59:59"],
];

test("fixed: vectors", () => {
  for (const [v, n, want] of FIXED_VECTORS) {
    assert.equal(fmt.fixed(v, n), want, `fixed(${v}, ${n})`);
  }
});

test("fixed: never emits exponent notation", () => {
  for (const v of [1e14, 1e-12, 12345678.9]) {
    for (let n = 0; n < 7; n++) assert.ok(!fmt.fixed(v, n).toLowerCase().includes("e"));
  }
});

test("fixed: exact digit count", () => {
  for (let n = 0; n < 8; n++) {
    const s = fmt.fixed(1.23456789, n);
    if (n === 0) assert.equal(s, "1");
    else assert.equal(s.split(".")[1].length, n);
  }
});

test("civil: daysFromCivil", () => {
  for (const [y, m, d, want] of CIVIL_VECTORS) {
    assert.equal(fmt.daysFromCivil(y, m, d), want, `${y}-${m}-${d}`);
  }
});

test("civil: roundtrip including negative days", () => {
  for (let z = -30000; z < 90000; z += 97) {
    const [y, m, d] = fmt.civilFromDays(z);
    assert.equal(fmt.daysFromCivil(y, m, d), z);
  }
});

test("civil: iso", () => {
  for (const [t, want] of ISO_VECTORS) assert.equal(fmt.isoLocal(t), want);
  assert.equal(fmt.isoZ(1785750858.0), "2026-08-03T09:54:18Z");
  assert.equal(fmt.dateLocal(1785750858.0), "2026-08-03");
});

test("parseNum: valid", () => {
  const cases = [["1", 1], ["-2.5", -2.5], ["+3", 3], ["0.000001", 0.000001],
                 ["080.137840", 80.13784]];
  for (const [tok, want] of cases) assert.equal(fmt.parseNum(tok), want);
});

test("parseNum: invalid is NaN", () => {
  for (const tok of ["", "abc", "1.2.3", "1e5", "--1", "1,5", " 1"]) {
    assert.ok(Number.isNaN(fmt.parseNum(tok)), tok);
  }
});

test("json: escapes", () => {
  assert.equal(fmt.jsonStr('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(fmt.jsonStr("tab\there"), '"tab\\there"');
  assert.equal(fmt.jsonStr("\x01"), '"\\u0001"');
  assert.equal(fmt.jsonStr("café"), '"café"');
});

test("json: key order is insertion order", () => {
  const out = fmt.jsonValue({ b: 1, a: 2 });
  assert.ok(out.indexOf('"b"') < out.indexOf('"a"'));
});

test("csv: minimal quoting", () => {
  assert.equal(fmt.csvCell("plain"), "plain");
  assert.equal(fmt.csvCell("a,b"), '"a,b"');
  assert.equal(fmt.csvCell('say "hi"'), '"say ""hi"""');
});

test("byteKey: sorts by UTF-8 bytes, not UTF-16 code units", () => {
  const names = ["b.ts", "A.ts", "a.ts", "é.ts", "\u{1f600}.ts"];
  const got = names.slice().sort(fmt.cmpNames);
  assert.equal(got[0], "A.ts");
  assert.equal(got[got.length - 1], "\u{1f600}.ts");
});

test("haversine", () => {
  assert.ok(Math.abs(fmt.haversineM(0, 0, 1, 0) - 111194.9) < 1.0);
  assert.equal(fmt.haversineM(25.5, -80.1, 25.5, -80.1), 0);
});

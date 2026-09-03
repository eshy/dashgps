// Golden tests, mirroring python/tests/test_fixtures.py. Both suites enumerate
// fixtures/cases/*.json, so adding a case adds tests to both languages. spec/40-fixtures.md

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BytesReader, CountingReader, NoFormatMatch, ParseError, ParseOptions, formats, parseAuto }
  from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASES_DIR = join(ROOT, "fixtures", "cases");
const BIN_DIR = join(ROOT, "fixtures", "bin");
const GOLDEN_DIR = join(ROOT, "fixtures", "golden");
const CLI = join(ROOT, "js", "bin", "dashgps.js");

const TAIL_SNIFF_BUDGET = 65536;
const HEAD_SNIFF_BUDGET = 256 * 1024;

const CASES = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), "utf8")));

function readFixture(output) {
  return new Uint8Array(readFileSync(join(BIN_DIR, output)));
}

test("completeness: cases exist", () => {
  assert.ok(CASES.length > 0, "no fixture cases found");
});

test("completeness: every case has a binary and a golden", () => {
  for (const c of CASES) {
    statSync(join(BIN_DIR, c.output));
    assert.ok(statSync(join(GOLDEN_DIR, c.id)).isDirectory(),
      `missing golden for ${c.id}; run scripts/regen_golden.sh`);
  }
});

test("completeness: every golden has a case", () => {
  const ids = new Set(CASES.map((c) => c.id));
  for (const name of readdirSync(GOLDEN_DIR)) {
    if (statSync(join(GOLDEN_DIR, name)).isDirectory()) {
      assert.ok(ids.has(name), `golden ${name} has no case descriptor`);
    }
  }
});

test("completeness: manifest matches the binaries", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "fixtures", "manifest.json"), "utf8"));
  for (const c of CASES) {
    const data = readFileSync(join(BIN_DIR, c.output));
    assert.equal(manifest[c.output].size, data.length, c.output);
    assert.equal(manifest[c.output].sha256, createHash("sha256").update(data).digest("hex"),
      c.output);
  }
});

for (const c of CASES) {
  test(`expect: ${c.id}`, async () => {
    const reader = new CountingReader(new BytesReader(readFixture(c.output), c.output));
    let res = null;
    try {
      res = await parseAuto(reader, new ParseOptions());
    } catch (e) {
      if (!(e instanceof NoFormatMatch || e instanceof ParseError)) throw e;
    }
    if (c.expect.format === null) {
      assert.equal(res, null, `expected no format to match ${c.output}`);
      return;
    }
    assert.ok(res !== null, `expected ${c.output} to parse as ${c.expect.format}`);
    assert.equal(res.formatId, c.expect.format);
    assert.equal(res.points.length, c.expect.points);
    if (c.expect.stride !== undefined) assert.equal(res.meta.stride, c.expect.stride);
  });

  test(`golden: ${c.id}`, () => {
    const golden = join(GOLDEN_DIR, c.id);
    const tmp = mkdtempSync(join(tmpdir(), "dashgps-test-"));
    try {
      try {
        execFileSync(process.execPath, [CLI, "extract", join(BIN_DIR, c.output),
          "-o", tmp, "--group", "none", "--meta", "-q"], { stdio: "pipe" });
      } catch (e) {
        // Exit code 1 means nothing parsed, which is expected for the negative fixtures.
        if (e.status !== 1) throw e;
      }
      const want = readdirSync(golden).sort();
      const got = readdirSync(tmp).sort();
      assert.deepEqual(got, want, `output file set differs for ${c.id}`);
      for (const name of want) {
        const a = readFileSync(join(golden, name));
        const b = readFileSync(join(tmp, name));
        if (!a.equals(b)) {
          assert.fail(`${c.id}/${name} differs from the golden produced by the Python core\n` +
            `--- golden\n${a.toString("utf8").slice(0, 1200)}\n` +
            `--- got\n${b.toString("utf8").slice(0, 1200)}`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`io trace: ${c.id}`, async () => {
    const meta = JSON.parse(readFileSync(join(GOLDEN_DIR, c.id, "meta.json"), "utf8"));
    const entry = meta.files[0];
    const reader = new CountingReader(new BytesReader(readFixture(c.output), c.output));
    try {
      await parseAuto(reader, new ParseOptions());
    } catch (e) {
      if (!(e instanceof NoFormatMatch || e instanceof ParseError)) throw e;
    }
    assert.deepEqual(reader.ranges, entry.read_ranges,
      `IO trace changed for ${c.id}; if that is intended, regenerate the goldens`);
    assert.equal(reader.bytesRead, entry.bytes_read);
  });
}

test("sniff budgets: tail and head formats stay within their declared IO cost", async () => {
  for (const c of CASES) {
    const data = readFixture(c.output);
    for (const spec of formats()) {
      if (spec.cost === "full-scan") continue;
      const budget = spec.cost === "tail" ? TAIL_SNIFF_BUDGET : HEAD_SNIFF_BUDGET;
      const reader = new CountingReader(new BytesReader(data, c.output));
      try { await spec.sniff(reader, new ParseOptions()); } catch (e) { /* sniffs may throw */ }
      assert.ok(reader.bytesRead <= budget,
        `${spec.id} sniff read ${reader.bytesRead} bytes of ${c.output}, over its ` +
        `${spec.cost} budget of ${budget}`);
    }
  }
});

test("the headline claim: a large file costs a fraction of its size to parse", async () => {
  const data = readFixture("ligo_ts_trailer_large.ts");
  const reader = new CountingReader(new BytesReader(data, "large"));
  const res = await parseAuto(reader, new ParseOptions());
  assert.equal(res.formatId, "ligo.ts_trailer");
  assert.ok(reader.bytesRead < data.length / 10,
    `parsing read ${reader.bytesRead} of ${data.length} bytes; the tail-only read strategy ` +
    "has regressed");
});

#!/usr/bin/env node
// dashgps Node CLI.
//
// Its main job beyond convenience is the parity gate: it must produce byte-identical output to
// `python -m dashgps.cli` for the same inputs and flags. scripts/parity.sh diffs the two.

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  CountingReader, NoFormatMatch, ParseError, ParseOptions, PostOptions, VERSION,
  byteKey, cmpNames, csvw, fixed, geojsonw, gpxw, groupResults, isoLocal, jsonValue,
  parseAuto, sniffAll, summaryw, zipw, formats,
} from "../src/index.js";
import { NodeFileReader } from "../src/io_node.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTS = [".ts", ".mp4", ".mov", ".m2ts", ".mts"];

// Above this much input, full-scan formats are off unless explicitly asked for.
const AUTO_DEEP_BYTES = 512 * 1024 * 1024;

function human(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return fixed(n / 1024, 1) + " KB";
  if (n < 1024 * 1024 * 1024) return fixed(n / 1048576, 1) + " MB";
  return fixed(n / 1073741824, 2) + " GB";
}

function collect(paths, exts, recursive) {
  const out = [];
  const walk = (dir, deep) => {
    const names = readdirSync(dir).sort(cmpNames);
    for (const name of names) {
      const fp = join(dir, name);
      const st = statSync(fp);
      if (st.isDirectory()) {
        if (deep) walk(fp, deep);
      } else if (exts.indexOf(extname(name).toLowerCase()) >= 0) {
        out.push(fp);
      }
    }
  };
  for (const p of paths) {
    let st;
    try { st = statSync(p); } catch (e) {
      process.stderr.write("dashgps: no such file or directory: " + p + "\n");
      continue;
    }
    if (st.isDirectory()) walk(p, recursive);
    else out.push(p);
  }
  return out.sort(cmpNames);
}

function tzSeconds(s) {
  if (!s) return 0;
  let sign = 1;
  if (s[0] === "-") { sign = -1; s = s.slice(1); }
  else if (s[0] === "+") s = s.slice(1);
  s = s.split(":").join("");
  let h, m;
  if (s.length === 2) { h = Number(s); m = 0; }
  else if (s.length === 4) { h = Number(s.slice(0, 2)); m = Number(s.slice(2)); }
  else throw new Error("bad --tz-offset: expected +HH:MM");
  return sign * (h * 3600 + m * 60);
}

function bbox(points) {
  if (!points.length) return null;
  let w = points[0].lon, e = w, s = points[0].lat, n = s;
  for (const p of points) {
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return [w, s, e, n];
}

function safeName(label) {
  // Explicitly ASCII, matching the Python core. See cli.py::_safe.
  let out = "";
  for (const ch of label) {
    const c = ch.charCodeAt(0);
    const good = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      ch === "-" || ch === "_" || ch === ".";
    out += good ? ch : "_";
  }
  return out || "group";
}

async function parseOne(path, opts, only) {
  const name = basename(path);
  const inner = new NodeFileReader(path, name);
  const reader = new CountingReader(inner);
  const entry = {
    name, size: reader.size(), format: null, status: null, records: 0, points: 0,
    droppedNofix: 0, tStart: null, tEnd: null, bbox: null, warnings: [], error: null,
  };
  let res = null;
  try {
    res = await parseAuto(reader, opts, only);
  } catch (e) {
    if (e instanceof NoFormatMatch || e instanceof ParseError) entry.error = e.message;
    else entry.error = e.constructor.name + ": " + e.message;
  }
  if (res !== null) {
    entry.format = res.formatId;
    entry.status = res.status;
    entry.records = res.meta.records === undefined ? res.points.length : res.meta.records;
    entry.points = res.points.length;
    entry.droppedNofix = res.droppedNofix;
    entry.warnings = res.warnings.slice();
    if (res.points.length) {
      let lo = res.points[0].t, hi = lo;
      for (const p of res.points) { if (p.t < lo) lo = p.t; if (p.t > hi) hi = p.t; }
      entry.tStart = isoLocal(lo);
      entry.tEnd = isoLocal(hi);
      entry.bbox = bbox(res.points);
    }
  }
  inner.close();
  return { entry, res, reader };
}

function parseArgs(argv) {
  const a = {
    cmd: "extract", paths: [], out: "dashgps-out", zip: null,
    format: "csv,gpx,geojson,summary", group: "day", recursive: false, include: null,
    only: null, tzOffset: "", maxSpeed: 400, maxGap: 600, minRun: 60, decimate: 5,
    includeGlitch: false, noPoints: false, noDeep: false, rawNmea: false,
    tailCap: 1048576, chunk: 4194304, overlap: 4096, meta: false, json: false, quiet: false,
    redact: false, hexdump: false,
  };
  const known = ["extract", "formats", "inspect"];
  let i = 0;
  if (argv.length && known.indexOf(argv[0]) >= 0) { a.cmd = argv[0]; i = 1; }
  const num = (v) => Number(v);
  for (; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case "-o": case "--out": a.out = argv[++i]; break;
      case "--zip": a.zip = argv[++i]; break;
      case "--format": a.format = argv[++i]; break;
      case "--group": a.group = argv[++i]; break;
      case "-r": case "--recursive": a.recursive = true; break;
      case "--include": a.include = argv[++i]; break;
      case "--only": a.only = argv[++i]; break;
      case "--tz-offset": a.tzOffset = argv[++i]; break;
      case "--max-speed": a.maxSpeed = num(argv[++i]); break;
      case "--max-gap": a.maxGap = num(argv[++i]); break;
      case "--min-run": a.minRun = num(argv[++i]); break;
      case "--decimate": a.decimate = num(argv[++i]); break;
      case "--include-glitch": a.includeGlitch = true; break;
      case "--no-points": a.noPoints = true; break;
      case "--deep": a.deep = true; break;
      case "--no-deep": a.noDeep = true; break;
      case "--scan-cap": a.scanCap = num(argv[++i]); break;
      case "--raw-nmea": a.rawNmea = true; break;
      case "--tail-cap": a.tailCap = num(argv[++i]); break;
      case "--chunk": a.chunk = num(argv[++i]); break;
      case "--overlap": a.overlap = num(argv[++i]); break;
      case "--meta": a.meta = true; break;
      case "--json": a.json = true; break;
      case "--redact": a.redact = true; break;
      case "--hexdump": a.hexdump = true; break;
      case "-q": case "--quiet": a.quiet = true; break;
      case "--version": process.stdout.write("dashgps " + VERSION + "\n"); process.exit(0); break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default:
        if (t.startsWith("-")) { process.stderr.write("unknown option: " + t + "\n"); process.exit(2); }
        a.paths.push(t);
    }
  }
  return a;
}

function usage() {
  process.stdout.write(
    "usage: dashgps [extract] PATH... [-o OUT] [--zip FILE] [--format LIST] [--group day|file|none]\n" +
    "       dashgps formats\n" +
    "       dashgps inspect FILE [--redact] [--hexdump]\n\n" +
    "Extract GPS tracks from dashcam video files. Your video never leaves your machine.\n"
  );
}

async function cmdExtract(a) {
  const exts = a.include
    ? a.include.toLowerCase().split(",").map((x) => (x.startsWith(".") ? x : "." + x))
    : DEFAULT_EXTS;
  const files = collect(a.paths, exts, a.recursive);
  if (!files.length) { process.stderr.write("dashgps: no input files\n"); return 2; }

  // Deep detection runs the full-scan formats, which cost a pass over every file the cheap
  // formats did not claim. On by default only for small inputs; --deep forces it.
  let total = 0;
  for (const f of files) {
    try { total += statSync(f).size; } catch (e) { /* counted as zero */ }
  }
  let deep;
  if (a.deep) deep = true;
  else if (a.noDeep) deep = false;
  else {
    deep = total <= AUTO_DEEP_BYTES;
    if (!deep && !a.quiet) {
      process.stderr.write("dashgps: " + human(total) +
        " of input; skipping the full-scan formats. Pass --deep to run them, " +
        "or --only <format> to force one.\n");
    }
  }
  const opts = new ParseOptions({
    tailCap: a.tailCap, chunk: a.chunk, overlap: a.overlap, deep,
    tzOffsetS: tzSeconds(a.tzOffset), rawNmea: a.rawNmea, scanCap: a.scanCap,
  });
  const post = new PostOptions({
    maxSpeedKmh: a.maxSpeed, maxGapS: a.maxGap, minRunPoints: a.minRun, decimateS: a.decimate,
  });
  const want = a.format.split(",").map((x) => x.trim()).filter(Boolean);

  const entries = [];
  const results = [];
  const traces = [];
  const sources = [];
  let naive = true;
  for (let i = 0; i < files.length; i++) {
    const { entry, res, reader } = await parseOne(files[i], opts, a.only);
    entries.push(entry);
    traces.push({
      file: entry.name,
      format: entry.format,
      status: entry.status,
      meta: res !== null ? res.meta : {},
      warnings: entry.warnings,
      error: entry.error,
      read_ranges: reader.ranges,
      bytes_read: reader.bytesRead,
      file_size: entry.size,
    });
    if (res !== null) {
      const si = sources.length;
      sources.push(entry.name);
      for (const p of res.points) p.src = si;
      results.push(res);
      if (!res.timeIsNaive) naive = false;
    }
    if (!a.quiet) {
      process.stderr.write("[" + (i + 1) + "/" + files.length + "] " + entry.name + "  " +
        (entry.format || "-") + "  " + entry.points + " points" +
        (entry.error ? "  ERROR: " + entry.error : "") + "\n");
    }
  }

  const groups = groupResults(results, a.group, post);
  const ctx = {
    version: VERSION, timeIsNaive: naive, includeGlitch: a.includeGlitch, points: !a.noPoints,
  };

  const enc = new TextEncoder();
  const members = [];
  for (const g of groups) {
    const base = safeName(g.label);
    if (want.indexOf("csv") >= 0) {
      const buf = []; csvw.write(buf, g, sources);
      members.push([base + ".csv", enc.encode(buf.join(""))]);
    }
    if (want.indexOf("gpx") >= 0) {
      const buf = []; gpxw.write(buf, g, ctx);
      members.push([base + ".gpx", enc.encode(buf.join(""))]);
    }
    if (want.indexOf("geojson") >= 0) {
      const buf = []; geojsonw.write(buf, g, ctx);
      members.push([base + ".geojson", enc.encode(buf.join(""))]);
    }
  }
  if (want.indexOf("summary") >= 0) {
    const buf = []; summaryw.write(buf, entries, groups, ctx);
    members.push(["summary.json", enc.encode(buf.join(""))]);
  }
  if (a.meta) {
    members.push(["meta.json", enc.encode(jsonValue({ files: traces }) + "\n")]);
  }
  members.sort((x, y) => cmpNames(x[0], y[0]));

  if (a.zip) {
    writeFileSync(a.zip, zipw.build(members));
    if (!a.quiet) process.stderr.write("wrote " + a.zip + " (" + members.length + " members)\n");
  } else {
    mkdirSync(a.out, { recursive: true });
    for (const [name, data] of members) writeFileSync(join(a.out, name), data);
    if (!a.quiet) {
      process.stderr.write("wrote " + members.length + " files to " + a.out + "\n");
    }
  }
  if (a.json) {
    const buf = []; summaryw.write(buf, entries, groups, ctx);
    process.stdout.write(buf.join(""));
  }
  let failed = 0;
  for (const e of entries) if (e.error) failed += 1;
  return failed === entries.length ? 1 : 0;
}

function cmdFormats() {
  const rows = [["ID", "NAME", "STATUS", "IO COST", "EXTENSIONS"]];
  for (const f of formats()) {
    rows.push([f.id, f.name, f.status, f.cost, f.extensions.join(" ")]);
  }
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
  rows.forEach((r, i) => {
    process.stdout.write([0, 1, 2, 3, 4].map((j) => r[j].padEnd(w[j])).join("  ").replace(/\s+$/, "") + "\n");
    if (i === 0) process.stdout.write(w.map((n) => "-".repeat(n)).join("  ") + "\n");
  });
  return 0;
}

async function cmdInspect(a) {
  const path = a.paths[0];
  if (!path) { usage(); return 2; }
  const opts = new ParseOptions({ deep: true });
  let reader = new CountingReader(new NodeFileReader(path, basename(path)));
  const n = reader.size();
  process.stdout.write("file        " + basename(path) + "\n");
  process.stdout.write("size        " + n + " bytes\n");
  const tail = await reader.readRange(n > 16 ? n - 16 : 0, n);
  process.stdout.write("last 16     " +
    Array.from(tail).map((b) => b.toString(16).padStart(2, "0")).join(" ") + "\n");
  process.stdout.write("\nsniff scores\n");
  for (const [id, score] of await sniffAll(reader, opts)) {
    process.stdout.write("  " + id.padEnd(20) + " " + fixed(score, 2) + "\n");
  }
  reader = new CountingReader(new NodeFileReader(path, basename(path)));
  let res = null;
  try { res = await parseAuto(reader, opts); } catch (e) {
    process.stdout.write("\nno format parsed: " + e.message + "\n");
    return 1;
  }
  process.stdout.write("\nformat      " + res.formatId + " (" + res.status + ")\n");
  process.stdout.write("meta        " + jsonValue(res.meta, 3).split("\n").join("\n            ") + "\n");
  process.stdout.write("points      " + res.points.length +
    "  (dropped no-fix: " + res.droppedNofix + ")\n");
  for (const w of res.warnings) process.stdout.write("warning     " + w + "\n");
  process.stdout.write("\nIO          " + reader.bytesRead + " bytes read in " +
    reader.ranges.length + " ranges (" + fixed(n ? (100 * reader.bytesRead) / n : 0, 3) + "% of the file)\n");
  return 0;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === "formats") return cmdFormats();
  if (a.cmd === "inspect") return cmdInspect(a);
  if (!a.paths.length) { usage(); return 2; }
  return cmdExtract(a);
}

main().then((rc) => process.exit(rc)).catch((e) => {
  process.stderr.write("dashgps: " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(2);
});

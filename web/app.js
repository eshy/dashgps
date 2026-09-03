// dashgps browser app.
//
// The main thread never parses. It hands File objects to a pool of module workers and receives
// only parsed points back, so video bytes never cross to this thread and never leave the machine.

import {
  Point, PostOptions, VERSION, cmpNames, csvw, fixed, geojsonw, gpxw, groupResults, isoLocal,
  summaryw, zipw,
} from "./lib/index.js";
import { TrackMap } from "./map.js";

const $ = (id) => document.getElementById(id);
const EXTS = [".ts", ".mp4", ".mov", ".m2ts", ".mts"];
const PALETTE = [
  "#4493f8", "#3fb950", "#d29922", "#a371f7", "#f778ba",
  "#56d4dd", "#e3852b", "#7ee787", "#ff9492", "#9b8afb",
];

const state = {
  queued: 0,
  done: 0,
  results: [],       // { name, size, format, status, points: Point[], meta, warnings, error, ... }
  running: false,
  naive: true,
};

let map = null;
let workers = [];
let nextWorker = 0;
const inflight = new Map();

// ---------------------------------------------------------------- worker pool

function poolSize() {
  const n = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, n));
}

function startPool() {
  if (workers.length) return true;
  try {
    for (let i = 0; i < poolSize(); i++) {
      const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      w.onmessage = (ev) => onWorkerDone(ev.data);
      w.onerror = (e) => {
        setStatus("A worker failed to start (" + (e.message || "unknown") +
                  "). Falling back to single-threaded parsing.");
        workers = [];
      };
      workers.push(w);
    }
    return true;
  } catch (e) {
    workers = [];
    return false;
  }
}

function parseOptions() {
  return {
    deep: $("deep").checked,
    tzOffsetS: tzSeconds($("tz").value.trim()),
    tailCap: 1024 * 1024,
  };
}

function tzSeconds(s) {
  if (!s) return 0;
  let sign = 1;
  if (s[0] === "-") { sign = -1; s = s.slice(1); }
  else if (s[0] === "+") s = s.slice(1);
  s = s.split(":").join("");
  if (s.length === 2) return sign * Number(s) * 3600;
  if (s.length === 4) return sign * (Number(s.slice(0, 2)) * 3600 + Number(s.slice(2)) * 60);
  return 0;
}

async function enqueue(files) {
  if (!files.length) return;
  state.running = true;
  state.queued += files.length;
  render();
  const opts = parseOptions();
  const usePool = startPool();
  if (usePool) {
    for (const f of files) {
      const id = Math.random().toString(36).slice(2);
      inflight.set(id, true);
      const w = workers[nextWorker++ % workers.length];
      w.postMessage({ type: "parse", id, file: f.file, name: f.name, opts });
    }
  } else {
    // No module workers (older Safari). Parse on the main thread, yielding so the UI can breathe.
    const { BlobReader, CountingReader, ParseOptions, parseAuto } = await import("./lib/index.js");
    let i = 0;
    for (const f of files) {
      const reader = new CountingReader(new BlobReader(f.file, f.name));
      const out = {
        type: "done", id: String(i), name: f.name, size: f.file.size, format: null, status: null,
        points: [], meta: {}, warnings: [], droppedNofix: 0, timeIsNaive: true,
        bytesRead: 0, error: null,
      };
      try {
        const res = await parseAuto(reader, new ParseOptions(opts));
        out.format = res.formatId;
        out.status = res.status;
        out.meta = res.meta;
        out.warnings = res.warnings;
        out.droppedNofix = res.droppedNofix;
        out.timeIsNaive = res.timeIsNaive;
        out.points = res.points.map((p) => [p.t, p.lat, p.lon, p.speedKmh, p.headingDeg,
          p.altM, p.magvarDeg, p.ax, p.ay, p.az, p.idx]);
      } catch (e) {
        out.error = e && e.message ? e.message : String(e);
      }
      out.bytesRead = reader.bytesRead;
      onWorkerDone(out);
      if (++i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
}

function onWorkerDone(msg) {
  inflight.delete(msg.id);
  state.done += 1;
  state.results.push(msg);
  if (msg.timeIsNaive === false) state.naive = false;
  if (state.done >= state.queued) state.running = false;
  render();
  if (!state.running) refreshOutputs();
}

// ---------------------------------------------------------------- rebuilding points

// Results are sorted by filename before anything is produced, so worker completion order can
// never change the output bytes.
function orderedResults() {
  return state.results.slice().sort((a, b) => cmpNames(a.name, b.name));
}

function buildGroups() {
  const ordered = orderedResults();
  const sources = [];
  const parsed = [];
  for (const r of ordered) {
    if (r.error) continue;
    const si = sources.length;
    sources.push(r.name);
    const points = r.points.map((t) =>
      new Point(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], si));
    parsed.push({ sources: [r.name], points, formatId: r.format });
  }
  const post = new PostOptions({
    maxSpeedKmh: Number($("maxspeed").value) || 400,
    maxGapS: Number($("maxgap").value) || 600,
    minRunPoints: Number($("minrun").value) || 60,
    decimateS: Number($("decimate").value) || 5,
  });
  return { groups: groupResults(parsed, $("group").value, post), sources, ordered };
}

// ---------------------------------------------------------------- rendering

function setStatus(text) { $("status").textContent = text || ""; }

function badge(status) {
  const cls = status === "verified" ? "verified"
    : status === "reverse-engineered" ? "re" : "untested";
  const label = status === "reverse-engineered" ? "reverse-eng." : status;
  return '<span class="badge ' + cls + '">' + label + "</span>";
}

function render() {
  const pct = state.queued ? Math.round((100 * state.done) / state.queued) : 0;
  $("bar").style.width = pct + "%";
  $("progress").classList.toggle("hidden", state.queued === 0);

  let pts = 0;
  let ok = 0;
  let bytes = 0;
  let read = 0;
  for (const r of state.results) {
    pts += r.points.length;
    if (!r.error) ok += 1;
    bytes += r.size;
    read += r.bytesRead;
  }
  // Show the read ratio only when it is the interesting number. On small files the sniff and
  // parse passes overlap, so "read" can exceed the file size; claiming 108% would just confuse.
  const io = read < bytes
    ? "read " + human(read) + " of " + human(bytes) +
      " (" + fixed((100 * read) / bytes, 1) + "%)"
    : "read " + human(read);
  $("counts").innerHTML = state.queued
    ? "<span>" + state.done + " / " + state.queued + " files</span>" +
      "<span>" + ok + " with GPS</span>" +
      "<span>" + pts.toLocaleString() + " points</span>" +
      "<span>" + io + "</span>"
    : "";

  const rows = orderedResults().map((r) => {
    const cells = [
      '<td class="name">' + esc(r.name) + "</td>",
      '<td class="num">' + human(r.size) + "</td>",
      "<td>" + (r.format ? esc(r.format) + " " + badge(r.status) : "&mdash;") + "</td>",
      '<td class="num">' + (r.error ? "" : r.points.length) + "</td>",
      "<td>" + (r.error ? '<span class="err">' + esc(r.error) + "</span>"
        : esc(r.points.length ? isoLocal(r.points[0][0]).replace("T", " ") : "")) + "</td>",
    ];
    return "<tr>" + cells.join("") + "</tr>";
  });
  $("rows").innerHTML = rows.join("");
  $("results").classList.toggle("hidden", state.results.length === 0);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function human(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

let cached = null;

function refreshOutputs() {
  const parsed = state.results.filter((r) => !r.error).length;
  if (!parsed) {
    $("outputs").classList.add("hidden");
    if (state.results.length) {
      setStatus("No GPS data was found in these files. " +
        "If your dashcam records GPS, we would like a sample - see the link below.");
    }
    return;
  }
  cached = buildGroups();
  $("outputs").classList.remove("hidden");
  drawMap();
  const totals = cached.groups.reduce((a, g) => {
    let d = 0;
    for (const r of g.runs) if (!r.glitch) d += r.distanceKm;
    return { pts: a.pts + g.points.length, km: a.km + d };
  }, { pts: 0, km: 0 });
  setStatus(cached.groups.length + " group(s), " + totals.pts.toLocaleString() +
    " points, " + fixed(totals.km, 1) + " km" +
    (state.naive ? "  ·  times are the camera's own clock, with no timezone" : ""));
}

function drawMap() {
  if (!cached) return;
  const tracks = [];
  let gi = 0;
  for (const g of cached.groups) {
    const color = PALETTE[gi % PALETTE.length];
    gi += 1;
    for (const r of g.runs) {
      const pts = [];
      for (let i = r.start; i < r.end; i++) pts.push([g.points[i].lon, g.points[i].lat]);
      if (pts.length >= 2) tracks.push({ points: pts, color, outlier: r.glitch, terminal: false });
    }
    // Mark the first and last non-glitch run of each group with start/end dots.
    const solid = tracks.filter((t) => t.color === color && !t.outlier);
    if (solid.length) { solid[0].terminal = true; solid[solid.length - 1].terminal = true; }
  }
  map.setTracks(tracks);
  $("legend").innerHTML = cached.groups.map((g, i) =>
    '<span><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + esc(g.label) +
    "</span>").join("") +
    (tracks.some((t) => t.outlier)
      ? '<span><i style="background:var(--map-glitch)"></i>flagged glitch</span>' : "");
}

// ---------------------------------------------------------------- export

function safeName(label) {
  let out = "";
  for (const ch of label) {
    const c = ch.charCodeAt(0);
    const good = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      ch === "-" || ch === "_" || ch === ".";
    out += good ? ch : "_";
  }
  return out || "group";
}

function buildMembers() {
  const { groups, sources, ordered } = cached;
  const ctx = {
    version: VERSION, timeIsNaive: state.naive,
    includeGlitch: $("glitch").checked, points: $("gjpoints").checked,
  };
  const enc = new TextEncoder();
  const members = [];
  const want = {
    csv: $("f_csv").checked, gpx: $("f_gpx").checked,
    geojson: $("f_geojson").checked, summary: $("f_summary").checked,
  };
  for (const g of groups) {
    const base = safeName(g.label);
    if (want.csv) {
      const b = []; csvw.write(b, g, sources);
      members.push([base + ".csv", enc.encode(b.join(""))]);
    }
    if (want.gpx) {
      const b = []; gpxw.write(b, g, ctx);
      members.push([base + ".gpx", enc.encode(b.join(""))]);
    }
    if (want.geojson) {
      const b = []; geojsonw.write(b, g, ctx);
      members.push([base + ".geojson", enc.encode(b.join(""))]);
    }
  }
  if (want.summary) {
    const entries = ordered.map((r) => ({
      name: r.name, size: r.size, format: r.format, status: r.status,
      records: r.meta && r.meta.records !== undefined ? r.meta.records : r.points.length,
      points: r.points.length, droppedNofix: r.droppedNofix,
      tStart: r.points.length ? isoLocal(r.points[0][0]) : null,
      tEnd: r.points.length ? isoLocal(r.points[r.points.length - 1][0]) : null,
      bbox: bboxOf(r.points), warnings: r.warnings || [], error: r.error,
    }));
    const b = []; summaryw.write(b, entries, groups, ctx);
    members.push(["summary.json", enc.encode(b.join(""))]);
  }
  members.sort((a, b) => cmpNames(a[0], b[0]));
  return members;
}

function bboxOf(points) {
  if (!points.length) return null;
  let w = points[0][2], e = w, s = points[0][1], n = s;
  for (const p of points) {
    if (p[2] < w) w = p[2];
    if (p[2] > e) e = p[2];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

function download(name, data, mime) {
  const blob = new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function doDownload() {
  if (!cached) return;
  const members = buildMembers();
  if (!members.length) { setStatus("Choose at least one output format."); return; }
  if (members.length === 1) {
    const [name, data] = members[0];
    const mime = name.endsWith(".csv") ? "text/csv"
      : name.endsWith(".json") || name.endsWith(".geojson") ? "application/json"
      : name.endsWith(".gpx") ? "application/gpx+xml" : "text/plain";
    download(name, data, mime);
    setStatus("Downloaded " + name + ".");
    return;
  }
  download("dashgps.zip", zipw.build(members), "application/zip");
  setStatus("Downloaded dashgps.zip (" + members.length + " files).");
}

// ---------------------------------------------------------------- intake

function accept(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 && EXTS.indexOf(name.slice(i).toLowerCase()) >= 0;
}

function fromFileList(list, useRelative) {
  const out = [];
  for (const f of list) {
    const name = useRelative && f.webkitRelativePath ? f.webkitRelativePath : f.name;
    if (accept(name)) out.push({ name, file: f });
  }
  return out;
}

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    const name = prefix + f.name;
    if (accept(name)) out.push({ name, file: f });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries must be called repeatedly until it returns an empty batch.
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, prefix + entry.name + "/", out);
  }
}

async function fromDataTransfer(dt) {
  // Capture every item synchronously: the DataTransfer is neutered after the event turn.
  const entries = [];
  const plain = [];
  if (dt.items && dt.items.length) {
    for (const item of dt.items) {
      if (item.kind !== "file") continue;
      const e = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (e) entries.push(e);
      else { const f = item.getAsFile(); if (f) plain.push(f); }
    }
  }
  const out = [];
  for (const e of entries) await walkEntry(e, "", out);
  for (const f of plain) if (accept(f.name)) out.push({ name: f.name, file: f });
  if (!out.length && dt.files) return fromFileList(dt.files, false);
  return out;
}

async function pickDirectory() {
  if (!window.showDirectoryPicker) { $("folder").click(); return; }
  let handle;
  try { handle = await window.showDirectoryPicker(); } catch (e) { return; }
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === "file") {
        if (accept(name)) out.push({ name: prefix + name, file: await h.getFile() });
      } else {
        await walk(h, prefix + name + "/");
      }
    }
  };
  setStatus("Reading folder…");
  await walk(handle, "");
  setStatus("");
  enqueue(out);
}

function reset() {
  state.queued = 0;
  state.done = 0;
  state.results = [];
  state.naive = true;
  cached = null;
  $("outputs").classList.add("hidden");
  $("results").classList.add("hidden");
  setStatus("");
  render();
}

// ---------------------------------------------------------------- wiring

function init() {
  map = new TrackMap($("map"), { onStatus: setStatus });
  new ResizeObserver(() => map.resize()).observe($("map"));
  map.resize();

  $("files").addEventListener("change", (e) => enqueue(fromFileList(e.target.files, false)));
  $("folder").addEventListener("change", (e) => enqueue(fromFileList(e.target.files, true)));
  $("pickFiles").addEventListener("click", () => $("files").click());
  $("pickFolder").addEventListener("click", pickDirectory);
  $("clear").addEventListener("click", reset);
  $("download").addEventListener("click", doDownload);

  $("sample").addEventListener("click", async () => {
    setStatus("Loading the sample file…");
    try {
      const r = await fetch("./sample/dashgps-sample.ts");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      setStatus("");
      enqueue([{ name: "dashgps-sample.ts", file: new File([blob], "dashgps-sample.ts") }]);
    } catch (e) {
      setStatus("Could not load the sample file (" + e.message + ").");
    }
  });

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && drop.contains(e.relatedTarget)) return;
    drop.classList.remove("over");
  }));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    const files = await fromDataTransfer(e.dataTransfer);
    if (!files.length) { setStatus("No .ts or .mp4 files in that drop."); return; }
    enqueue(files);
  });

  $("tiles").addEventListener("change", (e) => map.setTiles(e.target.checked));
  $("fit").addEventListener("click", () => map.fit());
  for (const id of ["group", "glitch", "gjpoints", "maxspeed", "maxgap", "minrun", "decimate"]) {
    $(id).addEventListener("change", () => { if (state.results.length) refreshOutputs(); });
  }
  $("year").textContent = String(new Date().getFullYear());
  $("version").textContent = VERSION;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

// dashgps browser app.
//
// The main thread never parses. It hands File objects to a pool of module workers and receives
// only parsed points back, so video bytes never cross to this thread and never leave the machine.

import {
  BlobReader, CountingReader, ParseOptions, Point, PostOptions, VERSION, cmpNames, csvw, fixed,
  geojsonw, gpxw, groupResults, isoLocal, parseAuto, summaryw, zipw,
} from "./lib/index.js";
import { TrackMap } from "./map.js";

const $ = (id) => document.getElementById(id);
const EXTS = [".ts", ".mp4", ".mov", ".m2ts", ".mts"];

// Distinct on both grounds, and deliberately not the accent - the accent belongs to the interface,
// the track colours belong to the data.
const PALETTE = [
  "#0f8bd6", "#e0761a", "#12a17a", "#9a5ad6", "#d0417a",
  "#4aa3ff", "#c2a01c", "#5fbf6a", "#ff7f6b", "#7f8cff",
];

const state = {
  queued: 0,
  done: 0,
  results: [],
  running: false,
  naive: true,
  isSample: false,
};

let map = null;
let workers = [];
let nextWorker = 0;
let cached = null;

// ---------------------------------------------------------------- worker pool

function poolSize() {
  return Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
}

function startPool() {
  if (workers.length) return true;
  // The single-file build has no separate worker.js to load, so it parses on the main thread.
  if (window.__DASHGPS_INLINE__) return false;
  try {
    for (let i = 0; i < poolSize(); i++) {
      const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      w.onmessage = (ev) => onFileDone(ev.data);
      w.onerror = () => {
        setStatus("A worker could not start; parsing on the main thread instead.");
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
  return { deep: $("deep").checked, tzOffsetS: tzSeconds($("tz").value.trim()), tailCap: 1048576 };
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

async function parseHere(f, opts) {
  const reader = new CountingReader(new BlobReader(f.file, f.name));
  const out = {
    name: f.name, size: f.file.size, format: null, status: null, points: [], meta: {},
    warnings: [], droppedNofix: 0, timeIsNaive: true, bytesRead: 0, error: null,
  };
  try {
    const res = await parseAuto(reader, new ParseOptions(opts));
    out.format = res.formatId;
    out.status = res.status;
    out.meta = res.meta;
    out.warnings = res.warnings;
    out.droppedNofix = res.droppedNofix;
    out.timeIsNaive = res.timeIsNaive;
    out.points = res.points.map((p) => [p.t, p.lat, p.lon, p.speedKmh, p.headingDeg, p.altM,
      p.magvarDeg, p.ax, p.ay, p.az, p.idx]);
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  out.bytesRead = reader.bytesRead;
  return out;
}

async function enqueue(files, asSample) {
  if (!files.length) return;
  if (!asSample && state.isSample) reset(true);
  state.isSample = !!asSample;
  $("sampleNote").classList.toggle("hidden", !state.isSample);
  state.running = true;
  state.queued += files.length;
  render();
  const opts = parseOptions();
  if (startPool()) {
    for (const f of files) {
      const id = Math.random().toString(36).slice(2);
      workers[nextWorker++ % workers.length]
        .postMessage({ type: "parse", id, file: f.file, name: f.name, opts });
    }
    return;
  }
  let i = 0;
  for (const f of files) {
    onFileDone(await parseHere(f, opts));
    if (++i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

function onFileDone(msg) {
  state.done += 1;
  state.results.push(msg);
  if (msg.timeIsNaive === false) state.naive = false;
  if (state.done >= state.queued) state.running = false;
  render();
  if (!state.running) refreshOutputs();
}

// ---------------------------------------------------------------- assembling

// Sorted by filename before anything is produced, so worker completion order can never change
// the output bytes.
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
    parsed.push({
      sources: [r.name],
      formatId: r.format,
      points: r.points.map((t) =>
        new Point(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], si)),
    });
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

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function human(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";       // deterministic-ok: UI only
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";  // deterministic-ok: UI only
  return (n / 1073741824).toFixed(2) + " GB";                   // deterministic-ok: UI only
}

function badge(status) {
  const cls = status === "verified" ? "verified"
    : status === "reverse-engineered" ? "re" : "untested";
  const label = status === "reverse-engineered" ? "reverse-eng." : status;
  return '<span class="badge ' + cls + '">' + label + "</span>";
}

function render() {
  const pct = state.queued ? (100 * state.done) / state.queued : 0;
  $("bar").style.width = pct + "%";

  let pts = 0, ok = 0, bytes = 0, read = 0;
  for (const r of state.results) {
    pts += r.points.length;
    if (!r.error) ok += 1;
    bytes += r.size;
    read += r.bytesRead;
  }
  $("r-files").innerHTML = state.done + "<small> / " + state.queued + "</small>";
  $("r-ok").textContent = String(ok);
  $("r-points").textContent = pts.toLocaleString();
  // The ratio is the interesting number, but only while it is below 100 %: on tiny files the
  // sniff and parse passes overlap and claiming 108 % would just puzzle people.
  $("r-io").innerHTML = read < bytes
    ? human(read) + "<small> of " + human(bytes) + "</small>"
    : human(read);

  $("rows").innerHTML = orderedResults().map((r) =>
    "<tr>" +
    '<td class="name">' + esc(r.name) + "</td>" +
    '<td class="num">' + human(r.size) + "</td>" +
    "<td>" + (r.format ? badge(r.status) + " " + esc(r.format) : "&mdash;") + "</td>" +
    '<td class="num">' + (r.error ? "" : r.points.length) + "</td>" +
    "<td>" + (r.error ? '<span class="err">' + esc(r.error) + "</span>"
      : esc(r.points.length ? isoLocal(r.points[0][0]).replace("T", " ") : "")) + "</td>" +
    "</tr>").join("");
  $("filesNote").textContent = state.results.length
    ? state.done + " of " + state.queued : "drop some in";
}

function refreshOutputs() {
  const parsed = state.results.filter((r) => !r.error).length;
  if (!parsed) {
    cached = null;
    $("trackNote").textContent = "";
    if (state.results.length) {
      setStatus("No GPS data in these files. If your dashcam records GPS we would like a " +
                "diagnostic — see the link at the foot of the page.");
    }
    return;
  }
  cached = buildGroups();
  drawMap();
  let km = 0;
  let outliers = 0;
  for (const g of cached.groups) {
    for (const r of g.runs) if (!r.glitch) km += r.distanceKm;
    for (const p of g.points) if (p.outlier) outliers += 1;
  }
  $("r-km").innerHTML = fixed(km, 1) + "<small> km</small>";
  $("r-flagged").textContent = String(outliers);
  $("trackNote").textContent = cached.groups.length + " group" +
    (cached.groups.length === 1 ? "" : "s") + (outliers ? " · " + outliers + " flagged" : "");
  setStatus(state.naive
    ? "Timestamps are the camera's own clock and carry no timezone — set the offset under "
      + "Advanced to export real UTC."
    : "Timestamps are UTC.");
}

function drawMap() {
  const tracks = [];
  cached.groups.forEach((g, gi) => {
    const color = PALETTE[gi % PALETTE.length];
    const mine = [];
    for (const r of g.runs) {
      const pts = [];
      for (let i = r.start; i < r.end; i++) pts.push([g.points[i].lon, g.points[i].lat]);
      if (pts.length >= 2) {
        const t = { points: pts, color, outlier: r.glitch, terminal: false };
        tracks.push(t);
        if (!r.glitch) mine.push(t);
      }
    }
    if (mine.length) { mine[0].terminal = true; mine[mine.length - 1].terminal = true; }
  });
  map.setTracks(tracks);
  $("legend").innerHTML = cached.groups.map((g, i) =>
    '<span><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + esc(g.label) +
    "</span>").join("") +
    (tracks.some((t) => t.outlier)
      ? '<span><i style="background:var(--map-glitch)"></i>flagged</span>' : "");
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
    for (const [kind, ext, w] of [["csv", ".csv", csvw], ["gpx", ".gpx", gpxw],
                                  ["geojson", ".geojson", geojsonw]]) {
      if (!want[kind]) continue;
      const b = [];
      if (kind === "csv") w.write(b, g, sources); else w.write(b, g, ctx);
      members.push([base + ext, enc.encode(b.join(""))]);
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
    const b = [];
    summaryw.write(b, entries, groups, ctx);
    members.push(["summary.json", enc.encode(b.join(""))]);
  }
  members.sort((a, b) => cmpNames(a[0], b[0]));
  return members;
}

function download(name, data, mime) {
  // A host embedding this page may supply its own save function — a sandbox that blocks ordinary
  // downloads, a desktop shell, a kiosk. Falls through to a normal download when it does not.
  if (typeof window.__DASHGPS_SAVE__ === "function") {
    window.__DASHGPS_SAVE__(name, data, mime);
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime || "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function doDownload() {
  if (!cached) { setStatus("Nothing to export yet."); return; }
  const members = buildMembers();
  if (!members.length) { setStatus("Choose at least one output format."); return; }
  if (members.length === 1) {
    const [name, data] = members[0];
    const mime = name.endsWith(".csv") ? "text/csv"
      : name.endsWith(".gpx") ? "application/gpx+xml"
      : name.endsWith(".json") || name.endsWith(".geojson") ? "application/json" : "text/plain";
    download(name, data, mime);
    setStatus("Downloaded " + name + ".");
    return;
  }
  download("dashgps.zip", zipw.build(members), "application/zip");
  setStatus("Downloaded dashgps.zip — " + members.length + " files.");
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
      } else await walk(h, prefix + name + "/");
    }
  };
  setStatus("Reading folder…");
  await walk(handle, "");
  setStatus("");
  enqueue(out, false);
}

function reset(quiet) {
  state.queued = 0;
  state.done = 0;
  state.results = [];
  state.naive = true;
  state.isSample = false;
  cached = null;
  $("sampleNote").classList.add("hidden");
  $("r-km").innerHTML = '0.0<small> km</small>';
  $("r-flagged").textContent = "0";
  $("trackNote").textContent = "";
  map.setTracks([]);
  $("legend").innerHTML = "";
  if (!quiet) setStatus("");
  render();
}

async function loadSample() {
  try {
    let blob;
    if (window.__DASHGPS_SAMPLE__) {
      // Single-file build: the fixture rides along as base64.
      const bin = atob(window.__DASHGPS_SAMPLE__);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes]);
    } else {
      const r = await fetch("./sample/dashgps-sample.ts");
      if (!r.ok) throw new Error("HTTP " + r.status);
      blob = await r.blob();
    }
    enqueue([{ name: "sample-track.ts", file: new File([blob], "sample-track.ts") }], true);
  } catch (e) {
    setStatus("The sample file could not be loaded (" + e.message + "). Drop your own clips.");
  }
}

// ---------------------------------------------------------------- wiring

function init() {
  map = new TrackMap($("map"), { onStatus: setStatus });
  new ResizeObserver(() => map.resize()).observe($("map"));
  map.resize();

  $("files").addEventListener("change", (e) => enqueue(fromFileList(e.target.files, false), false));
  $("folder").addEventListener("change", (e) => enqueue(fromFileList(e.target.files, true), false));
  $("pickFiles").addEventListener("click", () => $("files").click());
  $("pickFolder").addEventListener("click", pickDirectory);
  $("clear").addEventListener("click", () => reset(false));
  $("dismissSample").addEventListener("click", () => reset(false));
  $("download").addEventListener("click", doDownload);
  $("sample").addEventListener("click", () => { reset(true); loadSample(); });

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
    enqueue(files, false);
  });

  $("tiles").addEventListener("change", (e) => map.setTiles(e.target.checked));
  $("fit").addEventListener("click", () => map.fit());
  for (const id of ["group", "glitch", "gjpoints", "maxspeed", "maxgap", "minrun", "decimate"]) {
    $(id).addEventListener("change", () => { if (state.results.length) refreshOutputs(); });
  }
  $("version").textContent = VERSION;

  // Open in a working state rather than as an empty shell, so the first look shows what the
  // tool does. Clearly labelled, and replaced the moment real files arrive.
  loadSample();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

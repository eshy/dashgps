// Build web/dist/dashgps-standalone.html — the whole tool in one file.
//
// Worth having in its own right: save it once and it works offline, forever, with no server and
// no install. It is also the only shape the tool can take inside a sandbox that will not serve
// sibling module files.
//
// The core is authored as ESM across ~20 modules, so this inlines them behind a minimal
// AMD-style registry rather than concatenating them: four modules export `write`, four export
// `sniff`, and a flat concatenation would collide. Only this project's own source is transformed,
// and its import/export style is deliberately plain — static named imports, no default exports,
// no computed specifiers — so the transformation stays small enough to read.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "js", "src");
const WEB = join(ROOT, "web");
const OUT = join(ROOT, "web", "dist", "dashgps-standalone.html");

const RE_IMPORT_NAMED = /^\s*import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/;
const RE_IMPORT_NS = /^\s*import\s*\*\s*as\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?\s*$/;
const RE_EXPORT_NS = /^\s*export\s*\*\s*as\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?\s*$/;
const RE_EXPORT_STAR = /^\s*export\s*\*\s*from\s*["']([^"']+)["']\s*;?\s*$/;
const RE_EXPORT_LIST = /^\s*export\s*\{([\s\S]*?)\}\s*;?\s*$/;
const RE_EXPORT_DECL =
  /^(\s*)export\s+(async\s+function\s*\*|async\s+function|function\s*\*|function|class|const|let|var)\s+(\w+)/;

/** Stable module id: core modules by their path under js/src, page modules by bare name. */
function idFor(file) {
  if (file.startsWith(SRC)) {
    return relative(SRC, file).split("\\").join("/").replace(/\.js$/, "");
  }
  return relative(WEB, file).split("\\").join("/").replace(/\.js$/, "");
}

/** `./lib/...` in the page source is `js/src/...` before build_web.mjs copies it. */
function resolveSpec(fromFile, spec) {
  let p = resolve(dirname(fromFile), spec);
  const libDir = join(WEB, "lib");
  if (p.startsWith(libDir)) p = join(SRC, relative(libDir, p));
  return p.endsWith(".js") ? p : p + ".js";
}

/** Fold multi-line import/export statements onto one line so the regexes above apply. */
function logicalLines(text) {
  const out = [];
  let buf = null;
  for (const line of text.split("\n")) {
    if (buf === null && !/^\s*import\s|^\s*export\s*[{*]/.test(line)) {
      out.push(line);
      continue;
    }
    buf = buf === null ? line : buf + " " + line.trim();
    const opens = (buf.match(/\{/g) || []).length;
    const closes = (buf.match(/\}/g) || []).length;
    const t = buf.trimEnd();
    if (opens === closes && /[;"'}]$/.test(t)) { out.push(buf); buf = null; }
  }
  if (buf !== null) out.push(buf);
  return out;
}

function transform(file) {
  const id = idFor(file);
  const exports = [];
  const starFrom = [];
  const body = [];

  for (const line of logicalLines(readFileSync(file, "utf8"))) {
    let m;
    if ((m = line.match(RE_EXPORT_NS))) {
      body.push(`const ${m[1]} = __req(${JSON.stringify(idFor(resolveSpec(file, m[2])))});`);
      exports.push([m[1], m[1]]);
    } else if ((m = line.match(RE_EXPORT_STAR))) {
      starFrom.push(idFor(resolveSpec(file, m[1])));
    } else if ((m = line.match(RE_IMPORT_NS))) {
      body.push(`const ${m[1]} = __req(${JSON.stringify(idFor(resolveSpec(file, m[2])))});`);
    } else if ((m = line.match(RE_IMPORT_NAMED))) {
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const p = s.split(/\s+as\s+/);
        return p.length === 2 ? `${p[0].trim()}: ${p[1].trim()}` : s;
      });
      body.push(`const { ${names.join(", ")} } = ` +
        `__req(${JSON.stringify(idFor(resolveSpec(file, m[2])))});`);
    } else if ((m = line.match(RE_EXPORT_LIST))) {
      for (const s of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
        const p = s.split(/\s+as\s+/);
        exports.push(p.length === 2 ? [p[0].trim(), p[1].trim()] : [s, s]);
      }
    } else if ((m = line.match(RE_EXPORT_DECL))) {
      exports.push([m[3], m[3]]);
      body.push(line.replace(/^(\s*)export\s+/, "$1"));
    } else if (/^\s*export\s/.test(line)) {
      throw new Error(`${id}: unsupported export form — teach build_single.mjs about it:\n${line}`);
    } else {
      body.push(line);
    }
  }

  // `import.meta` is a parse-time construct: leaving one in would break the whole classic
  // script even on a branch that never runs. It appears only as `new URL(x, import.meta.url)`
  // for resolving a sibling file, and `location.href` is the right base for that here.
  let src = body.join("\n").split("import.meta.url").join("location.href");
  if (/\bimport\.meta\b/.test(src)) {
    throw new Error(`${id}: import.meta survives inlining; rewrite it in the source`);
  }
  if (/\bimport\s*\(/.test(src)) {
    throw new Error(`${id}: dynamic import() cannot be inlined; hoist it to a static import`);
  }

  return [
    `__def(${JSON.stringify(id)}, function (__req) {`,
    src,
    "  const __x = {",
    ...exports.map(([local, name]) => `    ${JSON.stringify(name)}: ${local},`),
    "  };",
    ...starFrom.map((s) => `  Object.assign(__x, __req(${JSON.stringify(s)}));`),
    "  return __x;",
    "});",
  ].join("\n");
}

function listJs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) listJs(join(dir, e.name), out);
    // io_node.js imports node:fs and is unreachable from the browser entry point.
    else if (e.name.endsWith(".js") && e.name !== "io_node.js") out.push(join(dir, e.name));
  }
  return out;
}

const RUNTIME = `
// Minimal module registry. The core is ESM across ~20 files and several of them export the same
// names, so they are inlined as registered factories rather than concatenated.
const __defs = {}, __mods = {};
function __def(id, fn) { __defs[id] = fn; }
function __req(id) {
  if (!(id in __mods)) {
    if (!(id in __defs)) throw new Error("dashgps: missing module " + id);
    __mods[id] = __defs[id](__req);
  }
  return __mods[id];
}
// Tells app.js there is no sibling worker.js to load, so it parses on the main thread.
window.__DASHGPS_INLINE__ = true;
`.trim();

function main() {
  const core = listJs(SRC);
  const parts = core.map(transform);
  parts.push(transform(join(WEB, "map.js")));
  parts.push(transform(join(WEB, "app.js")));

  const sample = join(ROOT, "fixtures", "bin", "ligo_ts_trailer_basic.ts");
  const sampleB64 = existsSync(sample) ? readFileSync(sample).toString("base64") : "";

  const css = readFileSync(join(WEB, "styles.css"), "utf8");
  let html = readFileSync(join(WEB, "index.html"), "utf8");
  html = html.replace('<link rel="stylesheet" href="./styles.css">',
    "<style>\n" + css + "\n</style>");
  html = html.replace('<script type="module" src="./app.js"></script>', [
    "<script>",
    RUNTIME,
    `window.__DASHGPS_SAMPLE__ = ${JSON.stringify(sampleB64)};`,
    parts.join("\n\n"),
    '__req("app");',
    "<\/script>",
  ].join("\n"));

  writeFileSync(OUT, html);
  console.log(`built ${relative(ROOT, OUT)} — ` +
    `${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${parts.length} modules inlined`);
}

main();

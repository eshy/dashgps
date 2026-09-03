// Build the static site into web/dist. No bundler: the core is plain ESM and is copied verbatim,
// so what runs on the site is exactly what the tests exercise.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "web", "dist");

let sha = "dev";
try { sha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch (e) {}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "lib"), { recursive: true });
mkdirSync(join(DIST, "sample"), { recursive: true });

// io_node.js imports node:fs and is never reachable from the browser entry point, but shipping
// it would still be dead weight and a confusing import for anyone reading the deployed source.
cpSync(join(ROOT, "js", "src"), join(DIST, "lib"), {
  recursive: true,
  filter: (src) => !src.endsWith("io_node.js"),
});
for (const f of ["index.html", "app.js", "worker.js", "map.js", "styles.css"]) {
  cpSync(join(ROOT, "web", f), join(DIST, f));
}

// A synthetic fixture so a visitor with no dashcam can see the whole flow.
const sample = join(ROOT, "fixtures", "bin", "ligo_ts_trailer_basic.ts");
if (existsSync(sample)) cpSync(sample, join(DIST, "sample", "dashgps-sample.ts"));

// Cache-bust the entry point; the lib is imported relatively from it and follows.
const html = readFileSync(join(DIST, "index.html"), "utf8")
  .replace('src="./app.js"', 'src="./app.js?v=' + sha + '"')
  .replace('href="./styles.css"', 'href="./styles.css?v=' + sha + '"');
writeFileSync(join(DIST, "index.html"), html);

// GitHub Pages strips underscore-prefixed paths without this.
writeFileSync(join(DIST, ".nojekyll"), "");

console.log("built web/dist at " + sha);

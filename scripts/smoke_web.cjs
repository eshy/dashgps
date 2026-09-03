// Headless smoke test for the browser app.
//
// This is the check that matters most for the web deliverable: it proves the page parses a real
// fixture in a worker and produces the SAME bytes the CLI and the goldens produce.
//
// Playwright is resolved from wherever it happens to be installed; if it is not available the
// script exits 0 with a notice, so a contributor without it is not blocked.
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "web", "dist");
const FIXTURE = path.join(ROOT, "fixtures", "bin", "ligo_ts_trailer_basic.ts");
const GOLDEN = path.join(ROOT, "fixtures", "golden", "ligo_ts_trailer_basic", "all.csv");

let chromium;
for (const p of ["playwright", "/home/claude/.npm-global/lib/node_modules/playwright"]) {
  try { chromium = require(p).chromium; break; } catch (e) { /* keep looking */ }
}
if (!chromium) {
  console.log("smoke_web: playwright not available, skipping");
  process.exit(0);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".ts": "application/octet-stream", ".json": "application/json",
};

function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      const fp = path.join(dir, rel === "/" ? "index.html" : rel);
      if (!fp.startsWith(dir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); res.end("nope"); return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
      fs.createReadStream(fp).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve([srv, srv.address().port]));
  });
}

(async () => {
  const [srv, port] = await serve(DIST);
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ].filter(Boolean).filter((p) => fs.existsSync(p));
  const browser = await chromium.launch(
    candidates.length ? { executablePath: candidates[0] } : {});
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  // A blocked font or tile request is a network condition, not a page defect - the page is
  // required to work without them, so those are noted rather than failed on.
  const isNetwork = (t) => /net::ERR_|Failed to load resource/.test(t);
  const errors = [];
  const netnotes = [];
  const watch = (pg, sink) => {
    pg.on("pageerror", (e) => sink.push("pageerror: " + e.message));
    pg.on("console", (m) => {
      if (m.type() !== "error") return;
      (isNetwork(m.text()) ? netnotes : sink).push("console: " + m.text());
    });
  };
  watch(page, errors);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

  // The page opens with the bundled sample already parsed, so the first frame shows real output.
  await page.waitForFunction(() => document.getElementById("r-points").textContent !== "0",
    null, { timeout: 20000 });
  if (!(await page.isVisible("#sampleNote"))) throw new Error("sample notice should be visible");
  console.log("  opens with the sample loaded:", (await page.textContent("#r-points")).trim(),
    "points");

  await page.setInputFiles("#files", FIXTURE);
  await page.waitForFunction(
    () => document.getElementById("rows").textContent.includes("ligo_ts_trailer_basic"),
    null, { timeout: 20000 });
  if (await page.isVisible("#sampleNote")) {
    throw new Error("sample notice should clear once real files are dropped");
  }

  const rowText = await page.textContent("#rows");
  console.log("  status:", (await page.textContent("#status")).trim());
  if (!/296/.test(rowText)) throw new Error("expected 296 points in the file table, got: " + rowText);

  // CSV only, grouped like the golden, then compare bytes.
  await page.uncheck("#f_gpx");
  await page.uncheck("#f_summary");
  await page.selectOption("#group", "none");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#download"),
  ]);
  const tmp = path.join(require("os").tmpdir(), "dashgps-smoke.csv");
  await download.saveAs(tmp);
  const got = fs.readFileSync(tmp);
  const want = fs.readFileSync(GOLDEN);
  if (!got.equals(want)) {
    fs.writeFileSync("/tmp/smoke-got.csv", got);
    throw new Error("browser CSV differs from the golden (saved to /tmp/smoke-got.csv)");
  }
  console.log("  browser CSV is byte-identical to the golden (" + want.length + " bytes)");

  // The map must render without throwing.
  await page.click("#fit");
  await page.waitForTimeout(250);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: "/tmp/dashgps-web.png", fullPage: true });

  // The single-file build must behave the same, with no server and no module loading at all.
  const single = path.join(DIST, "dashgps-standalone.html");
  if (fs.existsSync(single)) {
    const p2 = await ctx.newPage();
    const errs2 = [];
    watch(p2, errs2);
    await p2.goto("file://" + single);
    await p2.waitForFunction(() => document.getElementById("r-points").textContent !== "0",
      null, { timeout: 20000 });
    const pts = (await p2.textContent("#r-points")).trim();
    if (pts !== "296") throw new Error("standalone: expected 296 sample points, got " + pts);
    await p2.evaluate(() => window.scrollTo(0, 0));
    await p2.waitForTimeout(250);
    await p2.screenshot({ path: "/tmp/dashgps-standalone.png", fullPage: true });
    if (errs2.length) throw new Error("standalone page errors:\n" + errs2.join("\n"));
    console.log("  standalone build runs from file:// with " + pts + " points");
    await p2.close();
  }

  await browser.close();
  srv.close();
  if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exit(1); }
  if (netnotes.length) {
    console.log("  (" + netnotes.length + " external request(s) blocked in this sandbox; " +
      "the page rendered without them, which is the required behaviour)");
  }
  console.log("smoke_web: OK");
})().catch((e) => { console.error("smoke_web FAILED:", e.message); process.exit(1); });

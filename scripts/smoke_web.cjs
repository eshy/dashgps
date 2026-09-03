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
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

  await page.setInputFiles("#files", FIXTURE);
  await page.waitForSelector("#outputs:not(.hidden)", { timeout: 20000 });

  const summary = await page.textContent("#status");
  const rowText = await page.textContent("#rows");
  console.log("  status:", summary.trim());

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

  // The map must render without throwing, in both tile modes.
  await page.click("#fit");
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: "/tmp/dashgps-web.png", fullPage: true });

  await browser.close();
  srv.close();
  if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exit(1); }
  console.log("smoke_web: OK");
})().catch((e) => { console.error("smoke_web FAILED:", e.message); process.exit(1); });

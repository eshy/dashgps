// A small self-contained track renderer.
//
// Deliberately not Leaflet: the page must work with no network at all, and pulling a mapping
// library in for what is really "draw some polylines in Web Mercator" costs more than it gives.
// Raster tiles are optional and off by default in the privacy sense - they are the only thing on
// this page that talks to a server.

const TILE = 256;
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAX_VERTICES = 6000; // per track; beyond this we stride-sample for the draw only

function lon2x(lon) { return (lon + 180) / 360; }
function lat2y(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
function x2lon(x) { return x * 360 - 180; }
function y2lat(y) {
  const n = Math.PI * (1 - 2 * y);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export class TrackMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tracks = [];     // { points: [[lon,lat],...], color, outlier }
    this.centerX = 0.5;
    this.centerY = 0.5;
    this.scale = TILE;    // pixels for the whole world
    this.tiles = false;
    this.tileCache = new Map();
    this.pending = new Set();
    this.onStatus = opts.onStatus || (() => {});
    this._drag = null;
    this._raf = 0;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this._drag = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener("pointermove", (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag = { x: e.clientX, y: e.clientY };
      this.centerX -= dx / this.scale;
      this.centerY -= dy / this.scale;
      this.draw();
    });
    const stop = (e) => {
      if (this._drag) { this._drag = null; try { c.releasePointerCapture(e.pointerId); } catch (_) {} }
    };
    c.addEventListener("pointerup", stop);
    c.addEventListener("pointercancel", stop);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      this.zoomAt(px, py, e.deltaY < 0 ? 1.25 : 1 / 1.25);
    }, { passive: false });
    // Keyboard access: the canvas is focusable and arrow keys pan.
    c.addEventListener("keydown", (e) => {
      const step = 40;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        this.centerX += moves[e.key][0] / this.scale;
        this.centerY += moves[e.key][1] / this.scale;
        this.draw();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        this.zoomAt(c.width / 2 / this.dpr(), c.height / 2 / this.dpr(), 1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        this.zoomAt(c.width / 2 / this.dpr(), c.height / 2 / this.dpr(), 1 / 1.25);
      }
    });
  }

  dpr() { return window.devicePixelRatio || 1; }

  zoomAt(px, py, factor) {
    const w = this.canvas.width / this.dpr();
    const h = this.canvas.height / this.dpr();
    const wx = this.centerX + (px - w / 2) / this.scale;
    const wy = this.centerY + (py - h / 2) / this.scale;
    const next = Math.min(TILE * Math.pow(2, 19), Math.max(TILE, this.scale * factor));
    this.scale = next;
    this.centerX = wx - (px - w / 2) / this.scale;
    this.centerY = wy - (py - h / 2) / this.scale;
    this.draw();
  }

  setTracks(tracks) {
    this.tracks = tracks;
    this.fit();
  }

  setTiles(on) {
    this.tiles = on;
    this.draw();
  }

  fit() {
    let minX = 1, maxX = 0, minY = 1, maxY = 0, any = false;
    for (const t of this.tracks) {
      if (t.outlier) continue;
      for (const [lon, lat] of t.points) {
        const x = lon2x(lon);
        const y = lat2y(lat);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        any = true;
      }
    }
    if (!any) { this.centerX = 0.5; this.centerY = 0.5; this.scale = TILE; this.draw(); return; }
    const w = Math.max(1, this.canvas.width / this.dpr());
    const h = Math.max(1, this.canvas.height / this.dpr());
    const dx = Math.max(maxX - minX, 1e-7);
    const dy = Math.max(maxY - minY, 1e-7);
    this.scale = Math.min((w * 0.88) / dx, (h * 0.88) / dy);
    this.scale = Math.min(this.scale, TILE * Math.pow(2, 19));
    this.scale = Math.max(this.scale, TILE);
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
    this.draw();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const d = this.dpr();
    this.canvas.width = Math.max(1, Math.round(r.width * d));
    this.canvas.height = Math.max(1, Math.round(r.height * d));
    this.draw();
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _style(name, fallback) {
    const v = getComputedStyle(this.canvas).getPropertyValue(name).trim();
    return v || fallback;
  }

  _draw() {
    const ctx = this.ctx;
    const d = this.dpr();
    const w = this.canvas.width / d;
    const h = this.canvas.height / d;
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = this._style("--map-bg", "#0e1116");
    ctx.fillRect(0, 0, w, h);

    if (this.tiles) this._drawTiles(ctx, w, h);
    else this._drawGraticule(ctx, w, h);

    const ox = this.centerX * this.scale - w / 2;
    const oy = this.centerY * this.scale - h / 2;

    // Glitch-flagged runs first, so real track draws on top of them.
    for (const pass of [true, false]) {
      for (const t of this.tracks) {
        if (!!t.outlier !== pass) continue;
        const pts = t.points;
        if (pts.length < 2) continue;
        const stride = Math.max(1, Math.ceil(pts.length / MAX_VERTICES));
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += stride) {
          const x = lon2x(pts[i][0]) * this.scale - ox;
          const y = lat2y(pts[i][1]) * this.scale - oy;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(lon2x(last[0]) * this.scale - ox, lat2y(last[1]) * this.scale - oy);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (t.outlier) {
          ctx.strokeStyle = this._style("--map-glitch", "#c2410c");
          ctx.setLineDash([4, 5]);
          ctx.lineWidth = 1.5;
        } else {
          ctx.strokeStyle = t.color;
          ctx.setLineDash([]);
          ctx.lineWidth = 2.5;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Start and end of each non-glitch track.
    for (const t of this.tracks) {
      if (t.outlier || t.points.length < 2 || !t.terminal) continue;
      for (const [pt, fill] of [[t.points[0], this._style("--map-start", "#16a34a")],
                                [t.points[t.points.length - 1], this._style("--map-end", "#dc2626")]]) {
        const x = lon2x(pt[0]) * this.scale - ox;
        const y = lat2y(pt[1]) * this.scale - oy;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = this._style("--map-bg", "#0e1116");
        ctx.stroke();
      }
    }
    ctx.restore();
    this._drawScale(ctx, w, h, d);
  }

  _drawScale(ctx, w, h, d) {
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    // metres per pixel at the current centre latitude
    const lat = y2lat(this.centerY);
    // resolution at zoom z is 156543.03392*cos(lat)/2^z, and scale = TILE * 2^z
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180) * TILE) / this.scale;
    let target = mpp * 90;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= target) || pow * 10;
    const px = nice / mpp;
    const label = nice >= 1000 ? (nice / 1000) + " km" : nice + " m";
    ctx.strokeStyle = this._style("--map-fg", "#8b949e");
    ctx.fillStyle = this._style("--map-fg", "#8b949e");
    ctx.lineWidth = 1;
    const x0 = 12;
    const y0 = h - 16;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + px, y0);
    ctx.lineTo(x0 + px, y0 - 4);
    ctx.stroke();
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(label, x0 + px + 6, y0 + 3);
    ctx.restore();
  }

  _drawGraticule(ctx, w, h) {
    const ox = this.centerX * this.scale - w / 2;
    const oy = this.centerY * this.scale - h / 2;
    ctx.strokeStyle = this._style("--map-grid", "#1c222b");
    ctx.lineWidth = 1;
    const zoom = Math.log2(this.scale / TILE);
    let stepDeg = 10;
    for (const s of [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001]) {
      if ((s / 360) * this.scale > 60) { stepDeg = s; break; }
      stepDeg = s;
    }
    const west = x2lon((ox) / this.scale);
    const east = x2lon((ox + w) / this.scale);
    for (let lon = Math.floor(west / stepDeg) * stepDeg; lon < east + stepDeg; lon += stepDeg) {
      const x = lon2x(lon) * this.scale - ox;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    const north = y2lat(oy / this.scale);
    const south = y2lat((oy + h) / this.scale);
    for (let lat = Math.floor(south / stepDeg) * stepDeg; lat < north + stepDeg; lat += stepDeg) {
      const y = lat2y(lat) * this.scale - oy;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  _drawTiles(ctx, w, h) {
    const z = Math.max(0, Math.min(19, Math.round(Math.log2(this.scale / TILE))));
    const n = Math.pow(2, z);
    const zScale = TILE * n;
    const k = this.scale / zScale;
    const ox = this.centerX * this.scale - w / 2;
    const oy = this.centerY * this.scale - h / 2;
    const x0 = Math.floor((ox / k) / TILE);
    const y0 = Math.floor((oy / k) / TILE);
    const x1 = Math.ceil(((ox + w) / k) / TILE);
    const y1 = Math.ceil(((oy + h) / k) / TILE);
    for (let ty = Math.max(0, y0); ty < Math.min(n, y1); ty++) {
      for (let tx = Math.max(0, x0); tx < Math.min(n, x1); tx++) {
        const img = this._tile(z, tx, ty);
        const dx = tx * TILE * k - ox;
        const dy = ty * TILE * k - oy;
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, dx, dy, TILE * k + 1, TILE * k + 1);
        }
      }
    }
    ctx.fillStyle = this._style("--map-attrib-bg", "rgba(0,0,0,0.55)");
    const text = "© OpenStreetMap contributors";
    ctx.font = "10px system-ui, sans-serif";
    const tw = ctx.measureText(text).width + 8;
    ctx.fillRect(w - tw - 4, h - 16, tw, 14);
    ctx.fillStyle = this._style("--map-attrib-fg", "#e6edf3");
    ctx.fillText(text, w - tw, h - 6);
  }

  _tile(z, x, y) {
    const key = z + "/" + x + "/" + y;
    if (this.tileCache.has(key)) return this.tileCache.get(key);
    if (this.pending.has(key) || this.pending.size > 32) return null;
    this.pending.add(key);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => { this.pending.delete(key); this.tileCache.set(key, img); this.draw(); };
    img.onerror = () => {
      this.pending.delete(key);
      this.tileCache.set(key, null);
      this.onStatus("Map tiles could not be loaded. The track still renders without them.");
    };
    img.src = TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    return null;
  }
}

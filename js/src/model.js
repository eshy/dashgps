// Core data types. spec/00-model.md  (mirrors python/src/dashgps/model.py)

export class Point {
  constructor(t, lat, lon, speedKmh = NaN, headingDeg = NaN, altM = NaN, magvarDeg = NaN,
              ax = NaN, ay = NaN, az = NaN, idx = -1, src = 0) {
    this.t = t;
    this.lat = lat;
    this.lon = lon;
    this.speedKmh = speedKmh;
    this.headingDeg = headingDeg;
    this.altM = altM;
    this.magvarDeg = magvarDeg;
    this.ax = ax;
    this.ay = ay;
    this.az = az;
    this.idx = idx;
    this.src = src;
    this.dtS = NaN;
    this.run = 0;
    this.outlier = 0;
  }
}

export class ParseResult {
  constructor(formatId, status, sources = [], points = [], meta = {}, warnings = [],
              droppedNofix = 0, timeIsNaive = true) {
    this.formatId = formatId;
    this.status = status;
    this.sources = sources;
    this.points = points;
    this.meta = meta;
    this.warnings = warnings;
    this.droppedNofix = droppedNofix;
    this.timeIsNaive = timeIsNaive;
    this.error = null;
  }
  // Deduplicated by first occurrence: a resync that fires 300 times is one line, not 300.
  warn(msg) {
    if (this.warnings.indexOf(msg) < 0) this.warnings.push(msg);
  }
}

export class ParseOptions {
  constructor(o = {}) {
    this.tailCap = o.tailCap === undefined ? 1024 * 1024 : o.tailCap;
    this.chunk = o.chunk === undefined ? 4 * 1024 * 1024 : o.chunk;
    this.overlap = o.overlap === undefined ? 4096 : o.overlap;
    this.deep = o.deep === undefined ? true : o.deep;
    this.tzOffsetS = o.tzOffsetS === undefined ? 0 : o.tzOffsetS;
    this.rawNmea = o.rawNmea === undefined ? false : o.rawNmea;
    // A full-scan format reads at most this much from each end of the file.
    this.scanCap = o.scanCap === undefined ? 64 * 1024 * 1024 : o.scanCap;
    // Per-file memo, reset by parseAuto.
    this.probe = {};
  }
}

export class ParseError extends Error {}

export class NoFormatMatch extends Error {
  constructor(scores) {
    super("no known GPS format matched");
    this.scores = scores;
  }
}

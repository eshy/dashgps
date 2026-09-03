// One file per message. The File object goes into the worker; only parsed points come back, so
// video bytes never cross to the main thread and never leave the machine.

import { BlobReader, CountingReader, NoFormatMatch, ParseError, ParseOptions, parseAuto }
  from "./lib/index.js";

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== "parse") return;
  const { id, file, opts } = msg;
  const reader = new CountingReader(new BlobReader(file, msg.name));
  const out = {
    type: "done", id, name: msg.name, size: file.size,
    format: null, status: null, points: [], meta: {}, warnings: [],
    droppedNofix: 0, timeIsNaive: true, bytesRead: 0, error: null,
  };
  try {
    const res = await parseAuto(reader, new ParseOptions(opts));
    out.format = res.formatId;
    out.status = res.status;
    out.meta = res.meta;
    out.warnings = res.warnings;
    out.droppedNofix = res.droppedNofix;
    out.timeIsNaive = res.timeIsNaive;
    // Flat tuples rather than objects: cheaper to clone, and the main thread rebuilds Points.
    out.points = res.points.map((p) => [
      p.t, p.lat, p.lon, p.speedKmh, p.headingDeg, p.altM, p.magvarDeg, p.ax, p.ay, p.az, p.idx,
    ]);
  } catch (e) {
    out.error = (e instanceof NoFormatMatch || e instanceof ParseError)
      ? e.message : (e && e.message ? e.constructor.name + ": " + e.message : String(e));
  }
  out.bytesRead = reader.bytesRead;
  self.postMessage(out);
};

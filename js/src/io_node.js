// Node-only reader. Not imported by the browser build; see the "exports" map in package.json.

import { openSync, readSync, statSync, closeSync } from "node:fs";

export class NodeFileReader {
  constructor(path, name) {
    this.path = path;
    this.name = name === undefined ? path : name;
    this._fd = openSync(path, "r");
    this._size = statSync(path).size;
  }
  size() { return this._size; }
  async readRange(start, end) {
    if (start < 0) start = 0;
    if (end > this._size) end = this._size;
    if (end <= start) return new Uint8Array(0);
    const buf = Buffer.allocUnsafe(end - start);
    const n = readSync(this._fd, buf, 0, end - start, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  }
  close() { closeSync(this._fd); }
}

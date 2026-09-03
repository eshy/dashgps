# dashgps

Extract GPS tracks from dashcam video files. Zero dependencies; the same code runs in Node and in
the browser.

```console
$ npm install -g dashgps
$ dashgps ~/Dashcam/Trip -r -o tracks/
```

## As a library

```js
import { ParseOptions, parseAuto, csvw, groupResults, PostOptions } from "dashgps";
import { NodeFileReader } from "dashgps/io-node";

const reader = new NodeFileReader("20260803_095418_F.ts");
const res = await parseAuto(reader, new ParseOptions());
console.log(res.formatId, res.points.length);      // ligo.ts_trailer 157
```

In a browser, swap the reader — nothing else changes, and the file never leaves the machine:

```js
import { BlobReader, ParseOptions, parseAuto } from "dashgps";

const res = await parseAuto(new BlobReader(file), new ParseOptions());
```

`BlobReader` uses `Blob.slice()`, and for the primary format only the last 64 KB of each file is
ever read — a folder of 1 GB clips finishes in seconds.

## Supported formats

| Format | Where it lives | Status |
|---|---|---|
| `ligo.ts_trailer` | Plain-text trailer after the last MPEG-TS packet | **Verified** on ~1,230 real clips |
| `ligo.plain` | The same records in an MP4 `skip`/`free`/`udta` atom | Reverse-engineered |
| `viidure` | `Viidure` ASCII records on TS PID 0x0300 | Untested |
| `nmea` | `$--RMC`/`$--GGA` in TS private streams or MP4 atoms | Untested |

**Untested** means built from a published sample or a public standard, having never seen a file
from that camera. If you own one, please
[send a redacted diagnostic](https://github.com/dashgps/dashgps/issues/new?template=new-format.yml).

## Output parity

This package and the Python one are file-for-file mirrors, and CI diffs their output over the whole
fixture set — including ZIP bytes. Neither may use a built-in number, date or JSON formatter,
because those differ between the languages.

Full documentation and byte-level format specs: <https://github.com/dashgps/dashgps>

MIT licensed.

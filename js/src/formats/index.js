// Format registration.
//
// THE ORDER OF THESE CALLS IS PART OF THE SPEC (spec/00-model.md): it breaks ties between
// formats that score equally, so both language cores must register in the same order.

import { register } from "../registry.js";
import * as ligoTsTrailer from "./ligo_ts_trailer.js";
import * as ligoPlain from "./ligo_plain.js";
import * as viidure from "./viidure.js";
import * as nmea from "./nmea.js";

let done = false;

export function registerAll() {
  if (done) return;
  done = true;
  register(ligoTsTrailer.FORMAT_ID, "LigoGPS TS trailer", ligoTsTrailer.STATUS,
    "tail", [".ts"], ligoTsTrailer.sniff, ligoTsTrailer.parse);
  register(ligoPlain.FORMAT_ID, "LigoGPS plaintext block", ligoPlain.STATUS,
    "full-scan", [".mp4", ".mov", ".ts"], ligoPlain.sniff, ligoPlain.parse);
  register(viidure.FORMAT_ID, "Viidure / INNOVV text", viidure.STATUS,
    "full-scan", [".ts"], viidure.sniff, viidure.parse);
  register(nmea.FORMAT_ID, "NMEA 0183", nmea.STATUS,
    "full-scan", [".ts", ".mp4", ".mov"], nmea.sniff, nmea.parse);
}

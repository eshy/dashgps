// CSV writer. spec/21-outputs.md  (mirrors python/src/dashgps/writers/csvw.py)
//
// Column order is backward-compatible with the CSVs the original prototype produced;
// magvar_deg is the one added column.

import {
  P_ACCEL, P_ALT, P_ANGLE, P_DT, P_LATLON, P_SPEED, csvCell, fixed, isoLocal,
} from "../fmt.js";

export const HEADER =
  "day,timestamp,lat,lon,speed_kmh,heading_deg,altitude_m,magvar_deg," +
  "accel_x,accel_y,accel_z,dt_s,outlier,source_file";

export function write(out, group, sources) {
  out.push(HEADER);
  out.push("\n");
  const label = csvCell(group.label);
  for (const p of group.points) {
    const src = p.src >= 0 && p.src < sources.length ? sources[p.src] : "";
    out.push([
      label, isoLocal(p.t), fixed(p.lat, P_LATLON), fixed(p.lon, P_LATLON),
      fixed(p.speedKmh, P_SPEED), fixed(p.headingDeg, P_ANGLE),
      fixed(p.altM, P_ALT), fixed(p.magvarDeg, P_ANGLE),
      fixed(p.ax, P_ACCEL), fixed(p.ay, P_ACCEL), fixed(p.az, P_ACCEL),
      fixed(p.dtS, P_DT), p.outlier ? "1" : "0", csvCell(src),
    ].join(","));
    out.push("\n");
  }
}

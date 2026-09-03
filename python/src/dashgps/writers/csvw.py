"""CSV writer. spec/21-outputs.md.

Column order is backward-compatible with the CSVs the original prototype produced; magvar_deg is
the one added column. Downstream work that reads those files keeps working.
"""

from ..fmt import (
    P_ACCEL,
    P_ALT,
    P_ANGLE,
    P_DT,
    P_LATLON,
    P_SPEED,
    csv_cell,
    fixed,
    iso_local,
)

HEADER = (
    "day,timestamp,lat,lon,speed_kmh,heading_deg,altitude_m,magvar_deg,"
    "accel_x,accel_y,accel_z,dt_s,outlier,source_file"
)


def write(out, group, sources):
    out.append(HEADER)
    out.append("\n")
    label = csv_cell(group.label)
    for p in group.points:
        src = sources[p.src] if 0 <= p.src < len(sources) else ""
        row = (
            label, iso_local(p.t), fixed(p.lat, P_LATLON), fixed(p.lon, P_LATLON),
            fixed(p.speed_kmh, P_SPEED), fixed(p.heading_deg, P_ANGLE),
            fixed(p.alt_m, P_ALT), fixed(p.magvar_deg, P_ANGLE),
            fixed(p.ax, P_ACCEL), fixed(p.ay, P_ACCEL), fixed(p.az, P_ACCEL),
            fixed(p.dt_s, P_DT), "1" if p.outlier else "0", csv_cell(src),
        )
        out.append(",".join(row))
        out.append("\n")

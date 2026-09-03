"""Format registration.

The ORDER OF THESE CALLS IS PART OF THE SPEC (spec/00-model.md): it breaks ties between formats
that score equally, so both language cores must register in the same order.
"""

from ..registry import register
from . import ligo_plain, ligo_ts_trailer, nmea, viidure

register(
    ligo_ts_trailer.FORMAT_ID, "LigoGPS TS trailer", ligo_ts_trailer.STATUS,
    "tail", (".ts",), ligo_ts_trailer.sniff, ligo_ts_trailer.parse,
)
register(
    ligo_plain.FORMAT_ID, "LigoGPS plaintext block", ligo_plain.STATUS,
    "full-scan", (".mp4", ".mov", ".ts"), ligo_plain.sniff, ligo_plain.parse,
)
register(
    viidure.FORMAT_ID, "Viidure / INNOVV text", viidure.STATUS,
    "full-scan", (".ts",), viidure.sniff, viidure.parse,
)
register(
    nmea.FORMAT_ID, "NMEA 0183", nmea.STATUS,
    "full-scan", (".ts", ".mp4", ".mov"), nmea.sniff, nmea.parse,
)

#!/usr/bin/env python3
"""Deterministic synthetic fixture generator. spec/40-fixtures.md.

Real dashcam files cannot be committed: they are gigabytes each and their coordinates are the
owner's home address. Every dashgps test therefore runs against files built here from the layouts
documented in spec/.

Stdlib only. Any pseudo-randomness comes from an inline xorshift32 seeded per case, so output is
byte-identical on every platform and Python version. CI regenerates and runs
`git diff --exit-code`, so a change to this file that alters a fixture shows up as a review diff.

Usage:  python3 fixtures/build_fixtures.py [--check]
"""

import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "bin")
CASES = os.path.join(HERE, "cases")

LIGO = b"LIGOGPSINFO"


# ---------------------------------------------------------------- deterministic noise


class Rng:
    def __init__(self, seed):
        self.s = (seed & 0xFFFFFFFF) or 0x12345678

    def next(self):
        x = self.s
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self.s = x
        return x

    def bytes(self, n):
        return bytes(bytearray((self.next() >> 7) & 0xFF for _ in range(n)))


def u32be(v):
    return bytes(((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF))


# ---------------------------------------------------------------- track synthesis


def _civil_to_days(y, m, d):
    y -= 1 if m <= 2 else 0
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _days_to_civil(z):
    z += 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return (y + (1 if m <= 2 else 0), m, d)


def parse_stamp(s):
    return (
        _civil_to_days(int(s[0:4]), int(s[5:7]), int(s[8:10])) * 86400
        + int(s[11:13]) * 3600 + int(s[14:16]) * 60 + int(s[17:19])
    )


def fmt_stamp(t, sep="/"):
    days = t // 86400
    rem = t - days * 86400
    y, mo, d = _days_to_civil(days)
    return "%04d%s%02d%s%02d %02d:%02d:%02d" % (
        y, sep, mo, sep, d, rem // 3600, (rem // 60) % 60, rem % 60,
    )


def make_track(p):
    """Build a list of sample dicts by integrating motion forward, so consecutive points are
    always physically reachable at the stated speed. A track that is not plausible would trip the
    glitch detector and make every post-processing fixture meaningless."""
    t0 = parse_stamp(p.get("start", "2026/08/03 09:54:18"))
    n = p.get("n", 300)
    la = p.get("lat0", 25.774430)
    lo = p.get("lon0", -80.137840)
    hdg = p.get("hdg0", 259.0)
    spd = p.get("speed_kmh", 48.0)
    alt = p.get("alt_m", -8.0)
    nofix = p.get("nofix_prefix", 0)
    shape = p.get("path", "arc")
    gap_at = p.get("gap_at", -1)
    gap_s = p.get("gap_s", 0)
    glitch_at = p.get("glitch_at", -1)
    glitch_n = p.get("glitch_n", 0)
    glitch_dlat = p.get("glitch_dlat", 0.0)
    glitch_dlon = p.get("glitch_dlon", 0.0)

    deg_per_s = 0.0 if shape == "static" else spd / 3600.0 / 111.195
    out = []
    extra = 0
    for i in range(n):
        if i == gap_at:
            extra += gap_s
        tt = t0 + i + extra
        if i < nofix:
            out.append({"t": tt, "nofix": True})
            continue
        if shape == "arc":
            hdg = (hdg + 0.25) % 360.0
        r = hdg * math.pi / 180.0
        clat = math.cos(la * math.pi / 180.0)
        la += deg_per_s * math.cos(r)
        lo += deg_per_s * math.sin(r) / (clat if abs(clat) > 1e-6 else 1e-6)
        gl = glitch_at >= 0 and glitch_at <= i < glitch_at + glitch_n
        out.append({
            "t": tt, "nofix": False,
            "lat": la + (glitch_dlat if gl else 0.0),
            "lon": lo + (glitch_dlon if gl else 0.0),
            "speed": spd, "hdg": hdg,
            "alt": alt + (i % 5) - 2.0,
            "ax": 0.01 * (i % 3), "ay": 0.0, "az": 0.01 * ((i + 1) % 2),
        })
    return out


def ligo_text(s, with_ahm=True):
    if s["nofix"]:
        return fmt_stamp(s["t"]) + " N:0 E:0 0 km/h x:0.0 y:0.0 z:0.0" + (
            " A:0 H:0 M:0" if with_ahm else ""
        )
    la = s["lat"]
    lo = s["lon"]
    ns = "N" if la >= 0 else "S"
    ew = "E" if lo >= 0 else "W"
    body = "%s %s:%09.6f %s:%010.6f %.1f km/h x:%.2f y:%.2f z:%.2f" % (
        fmt_stamp(s["t"]), ns, abs(la), ew, abs(lo), s["speed"], s["ax"], s["ay"], s["az"],
    )
    if with_ahm:
        body += " A:%.1f H:%.1f M:%.1f" % (s["hdg"], s["alt"], 0.0)
    return body


# ---------------------------------------------------------------- containers


def ts_packets(count, rng, pid=0x0100):
    out = bytearray()
    for i in range(count):
        out.append(0x47)
        out.append((0x40 if i == 0 else 0x00) | ((pid >> 8) & 0x1F))
        out.append(pid & 0xFF)
        out.append(0x10 | (i & 0x0F))
        out.extend(rng.bytes(184))
    return bytes(out)


def ts_pes_stream(payloads, rng, pid=0x0300, pad_packets=8):
    """Wrap each payload in a PES packet spread over TS packets."""
    out = bytearray(ts_packets(pad_packets, rng))
    cc = 0
    for payload in payloads:
        # A well-formed private_stream_1 PES header: start code, stream id, 16-bit length,
        # then the 3-byte optional header (flags, flags, header_data_length = 0).
        body = b"\x80\x00\x00" + payload
        ln = len(body)
        pes = (b"\x00\x00\x01\xbd" + bytes(((ln >> 8) & 0xFF, ln & 0xFF)) + body)
        first = True
        pos = 0
        while pos < len(pes):
            chunk = pes[pos : pos + 184]
            pos += len(chunk)
            out.append(0x47)
            out.append((0x40 if first else 0x00) | ((pid >> 8) & 0x1F))
            out.append(pid & 0xFF)
            out.append(0x10 | (cc & 0x0F))
            cc += 1
            first = False
            out.extend(chunk)
            if len(chunk) < 184:
                out.extend(b"\xff" * (184 - len(chunk)))
        out.extend(ts_packets(2, rng))
    return bytes(out)


def ligo_block(records, stride, variant, count_field, index_base=1):
    body = bytearray(LIGO)
    body.append(variant)
    body.extend(b"\x20\x20\x00\x00")
    body.extend(u32be(count_field))
    for i, text in enumerate(records):
        rec = bytearray(u32be(index_base + i))
        raw = text.encode("ascii")
        rec.extend(raw)
        if len(rec) > stride:
            raise ValueError("record %d does not fit in stride %d" % (i, stride))
        rec.extend(b"\x00" * (stride - len(rec)))
        body.extend(rec)
    return bytes(body)


def wrap_block(payload, tag=b"SKIP", size_excl_header=False, size_override=None):
    size = len(payload) if size_excl_header else len(payload) + 8
    if size_override is not None:
        size = size_override
    return u32be(size) + tag + payload


def trailer(blocks, magic=b"####"):
    body = b"".join(blocks)
    return body + magic + u32be(len(body) + 8)


def mp4(atoms):
    ftyp = u32be(8 + 8) + b"ftyp" + b"isom" + u32be(512)
    return ftyp + b"".join(atoms)


def atom(atype, payload):
    return u32be(len(payload) + 8) + atype + payload


# ---------------------------------------------------------------- builders


def build_ligo_ts_trailer(p):
    rng = Rng(p.get("seed", 1))
    samples = make_track(p.get("track", {}))
    stride = p.get("stride", 140)
    texts = [ligo_text(s, p.get("with_ahm", True)) for s in samples]
    blocks = []
    for spec in p.get("blocks", [{"tag": "SKIP", "kind": "ligo"}]):
        tag = spec["tag"].encode("ascii")
        if spec["kind"] == "binary":
            junk = bytes(LIGO) + b"\x01\x02\x03" + rng.bytes(spec.get("bytes", 256))
            blocks.append(wrap_block(junk, tag, p.get("size_excl_header", False)))
        elif spec["kind"] == "corrupt":
            junk = rng.bytes(spec.get("bytes", 64))
            blocks.append(u32be(spec.get("size", 0xFFFF)) + tag + junk)
        else:
            payload = ligo_block(
                texts, stride, p.get("variant", 0x09),
                p.get("count_field", len(texts)),
            )
            blocks.append(wrap_block(payload, tag, p.get("size_excl_header", False)))
    tr = trailer(blocks, p.get("magic", "####").encode("ascii"))
    if p.get("bad_length"):
        tr = tr[:-4] + u32be(len(tr) + 10_000_000)
    return ts_packets(p.get("ts_packets", 64), rng) + tr


def build_ligo_mp4_atom(p):
    rng = Rng(p.get("seed", 2))
    samples = make_track(p.get("track", {}))
    stride = p.get("stride", 140)
    texts = [ligo_text(s) for s in samples]
    payload = ligo_block(texts, stride, p.get("variant", 0x05), len(texts))
    inner = atom(p.get("atom", "free").encode("ascii"), payload)
    if p.get("nest") == "udta":
        inner = atom(b"moov", atom(b"udta", inner))
    return mp4([atom(b"mdat", rng.bytes(p.get("mdat", 4096))), inner])


def build_ligo_ts_stream(p):
    rng = Rng(p.get("seed", 3))
    samples = make_track(p.get("track", {}))
    stride = p.get("stride", 140)
    payload = ligo_block([ligo_text(s) for s in samples], stride, 0x05, len(samples))
    return ts_packets(p.get("ts_packets", 32), rng) + payload + rng.bytes(64)


def build_viidure_ts(p):
    rng = Rng(p.get("seed", 4))
    samples = make_track(p.get("track", {}))
    recs = []
    for s in samples:
        if s["nofix"]:
            continue
        ns = "N" if s["lat"] >= 0 else "S"
        ew = "E" if s["lon"] >= 0 else "W"
        recs.append(
            ("Viidure%s %s:%.6f %s:%.6f %.1f km/h %.2f %.2f 10 x:%.3f y:%.3f z:%.3f\x00"
             % (fmt_stamp(s["t"]), ns, abs(s["lat"]), ew, abs(s["lon"]), s["speed"],
                s["hdg"], s["alt"], s["ax"], s["ay"], s["az"])).encode("ascii")
        )
    per = p.get("records_per_pes", 1)
    payloads = [b"".join(recs[i : i + per]) for i in range(0, len(recs), per)]
    return ts_pes_stream(payloads, rng, 0x0300, p.get("pad_packets", 8))


def _nmea(sentence):
    x = 0
    for b in sentence.encode("ascii"):
        x ^= b
    return ("$" + sentence + "*%02X\r\n" % x).encode("ascii")


def nmea_sentences(samples, want_rmc=True, want_gga=True, corrupt_every=0):
    out = []
    i = 0
    for s in samples:
        if s["nofix"]:
            continue
        i += 1
        hhmmss = fmt_stamp(s["t"])[11:].replace(":", "") + ".00"
        ddmmyy = "%s%s%s" % (fmt_stamp(s["t"])[8:10], fmt_stamp(s["t"])[5:7],
                             fmt_stamp(s["t"])[2:4])
        la = abs(s["lat"])
        lo = abs(s["lon"])
        lat_dm = "%09.4f" % (int(la) * 100 + (la - int(la)) * 60.0)
        lon_dm = "%010.4f" % (int(lo) * 100 + (lo - int(lo)) * 60.0)
        ns = "N" if s["lat"] >= 0 else "S"
        ew = "E" if s["lon"] >= 0 else "W"
        if want_rmc:
            body = "GPRMC,%s,A,%s,%s,%s,%s,%06.2f,%06.2f,%s,,," % (
                hhmmss, lat_dm, ns, lon_dm, ew, s["speed"] / 1.852, s["hdg"], ddmmyy,
            )
            sen = _nmea(body)
            if corrupt_every and i % corrupt_every == 0:
                sen = sen[:-4] + b"00\r\n"
            out.append(sen)
        if want_gga:
            out.append(_nmea("GPGGA,%s,%s,%s,%s,%s,1,08,0.9,%.1f,M,0.0,M,," % (
                hhmmss, lat_dm, ns, lon_dm, ew, s["alt"])))
    return out


def build_nmea_ts(p):
    rng = Rng(p.get("seed", 5))
    samples = make_track(p.get("track", {}))
    sen = nmea_sentences(samples, p.get("rmc", True), p.get("gga", True),
                         p.get("corrupt_every", 0))
    per = p.get("sentences_per_pes", 4)
    payloads = [b"".join(sen[i : i + per]) for i in range(0, len(sen), per)]
    return ts_pes_stream(payloads, rng, 0x0300, p.get("pad_packets", 8))


def build_nmea_mp4(p):
    rng = Rng(p.get("seed", 6))
    samples = make_track(p.get("track", {}))
    blob = b"".join(nmea_sentences(samples, p.get("rmc", True), p.get("gga", True)))
    return mp4([atom(b"mdat", rng.bytes(p.get("mdat", 2048))),
                atom(p.get("atom", "free").encode("ascii"), blob)])


def build_raw(p):
    rng = Rng(p.get("seed", 7))
    kind = p.get("kind", "noise")
    if kind == "empty":
        return b""
    if kind == "tiny":
        return b"\x47\x40\x00\x10" + rng.bytes(8)
    if kind == "mp4_nogps":
        return mp4([atom(b"mdat", rng.bytes(p.get("mdat", 8192)))])
    return rng.bytes(p.get("bytes", 4096))


BUILDERS = {
    "ligo_ts_trailer": build_ligo_ts_trailer,
    "ligo_mp4_atom": build_ligo_mp4_atom,
    "ligo_ts_stream": build_ligo_ts_stream,
    "viidure_ts": build_viidure_ts,
    "nmea_ts": build_nmea_ts,
    "nmea_mp4": build_nmea_mp4,
    "raw": build_raw,
}


# ---------------------------------------------------------------- the case list

_T = {"start": "2026/08/03 09:54:18", "n": 300, "nofix_prefix": 4}


def case(cid, spec, builder, output, expect, params):
    return {"id": cid, "spec": spec, "builder": builder, "output": output,
            "expect": expect, "params": params}


CASE_LIST = [
    # -- format A: the verified format ------------------------------------------------
    # Stride 132 is what every one of the ~1,230 real ICESKY clips uses.
    case("ligo_ts_trailer_basic", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_basic.ts",
         {"format": "ligo.ts_trailer", "points": 296, "stride": 132},
         {"seed": 11, "stride": 132, "track": dict(_T)}),
    case("ligo_ts_trailer_amp_magic", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_amp_magic.ts",
         {"format": "ligo.ts_trailer", "points": 60, "stride": 140},
         {"seed": 12, "stride": 140, "magic": "&&&&",
          "track": {"start": "2026/08/03 12:00:00", "n": 60, "nofix_prefix": 0}}),
    # A stride we have never seen in the wild, purely to prove the autodetect is not hard-coded.
    case("ligo_ts_trailer_stride140", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_stride140.ts",
         {"format": "ligo.ts_trailer", "points": 120, "stride": 140},
         {"seed": 13, "stride": 140,
          "track": {"start": "2026/08/04 08:00:00", "n": 120, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_multiblock", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_multiblock.ts",
         {"format": "ligo.ts_trailer", "points": 80, "stride": 140},
         {"seed": 14, "stride": 140,
          "blocks": [{"tag": "skip", "kind": "binary", "bytes": 512},
                     {"tag": "SKIP", "kind": "ligo"}],
          "track": {"start": "2026/08/05 07:30:00", "n": 80, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_size_excl_header", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_size_excl_header.ts",
         {"format": "ligo.ts_trailer", "points": 50, "stride": 140},
         {"seed": 15, "stride": 140, "size_excl_header": True,
          "blocks": [{"tag": "skip", "kind": "binary", "bytes": 128},
                     {"tag": "SKIP", "kind": "ligo"}],
          "track": {"start": "2026/08/06 06:00:00", "n": 50, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_resync", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_resync.ts",
         {"format": "ligo.ts_trailer", "points": 40, "stride": 140},
         {"seed": 16, "stride": 140,
          "blocks": [{"tag": "skip", "kind": "corrupt", "bytes": 96, "size": 3},
                     {"tag": "SKIP", "kind": "ligo"}],
          "track": {"start": "2026/08/07 05:00:00", "n": 40, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_count_zero", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_count_zero.ts",
         {"format": "ligo.ts_trailer", "points": 30, "stride": 140},
         {"seed": 17, "stride": 140, "count_field": 0,
          "track": {"start": "2026/08/08 04:00:00", "n": 30, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_count_high", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_count_high.ts",
         {"format": "ligo.ts_trailer", "points": 30, "stride": 140},
         {"seed": 18, "stride": 140, "count_field": 9999,
          "track": {"start": "2026/08/09 04:00:00", "n": 30, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_all_nofix", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_all_nofix.ts",
         {"format": "ligo.ts_trailer", "points": 0, "stride": 140},
         {"seed": 19, "stride": 140,
          "track": {"start": "2026/08/10 04:00:00", "n": 25, "nofix_prefix": 25}}),
    case("ligo_ts_trailer_no_ahm", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_no_ahm.ts",
         {"format": "ligo.ts_trailer", "points": 40, "stride": 140},
         {"seed": 20, "stride": 140, "with_ahm": False,
          "track": {"start": "2026/08/11 04:00:00", "n": 40, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_large", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_large.ts",
         {"format": "ligo.ts_trailer", "points": 300, "stride": 140},
         {"seed": 21, "stride": 140, "ts_packets": 12000,
          "track": {"start": "2026/08/12 04:00:00", "n": 300, "nofix_prefix": 0}}),
    case("ligo_ts_trailer_bad_length", "01-ligogps-ts-trailer", "ligo_ts_trailer",
         "ligo_ts_trailer_bad_length.ts",
         {"format": "ligo.plain", "points": 10},
         {"seed": 22, "stride": 140, "bad_length": True,
          "track": {"start": "2026/08/13 04:00:00", "n": 10, "nofix_prefix": 0}}),

    # -- post-processing behaviour -----------------------------------------------------
    case("post_glitch_burst", "20-postprocess", "ligo_ts_trailer",
         "post_glitch_burst.ts",
         {"format": "ligo.ts_trailer", "points": 200, "outliers": 12},
         {"seed": 30, "stride": 140,
          "track": {"start": "2026/08/19 11:00:00", "n": 200, "nofix_prefix": 0,
                    "glitch_at": 100, "glitch_n": 12,
                    "glitch_dlat": -0.9, "glitch_dlon": -1.4}}),
    case("post_long_gap", "20-postprocess", "ligo_ts_trailer",
         "post_long_gap.ts",
         {"format": "ligo.ts_trailer", "points": 150, "outliers": 0},
         {"seed": 31, "stride": 140,
          "track": {"start": "2026/08/20 11:00:00", "n": 150, "nofix_prefix": 0,
                    "gap_at": 75, "gap_s": 1800}}),
    case("post_static_noise", "20-postprocess", "ligo_ts_trailer",
         "post_static_noise.ts",
         {"format": "ligo.ts_trailer", "points": 120, "outliers": 0},
         {"seed": 32, "stride": 140,
          "track": {"start": "2026/08/21 11:00:00", "n": 120, "nofix_prefix": 0,
                    "path": "static", "speed_kmh": 0.0}}),

    # -- format B ----------------------------------------------------------------------
    case("ligo_plain_mp4_free", "02-ligogps-plaintext", "ligo_mp4_atom",
         "ligo_plain_mp4_free.mp4",
         {"format": "ligo.plain", "points": 60, "stride": 140},
         {"seed": 40, "stride": 140, "atom": "free",
          "track": {"start": "2026/08/14 09:00:00", "n": 60, "nofix_prefix": 0}}),
    case("ligo_plain_mp4_udta", "02-ligogps-plaintext", "ligo_mp4_atom",
         "ligo_plain_mp4_udta.mp4",
         {"format": "ligo.plain", "points": 45, "stride": 132},
         {"seed": 41, "stride": 132, "atom": "skip", "nest": "udta",
          "track": {"start": "2026/08/15 09:00:00", "n": 45, "nofix_prefix": 0}}),
    case("ligo_plain_ts_stream", "02-ligogps-plaintext", "ligo_ts_stream",
         "ligo_plain_ts_stream.ts",
         {"format": "ligo.plain", "points": 35, "stride": 140},
         {"seed": 42, "stride": 140,
          "track": {"start": "2026/08/16 09:00:00", "n": 35, "nofix_prefix": 0}}),

    # -- format C ----------------------------------------------------------------------
    case("viidure_basic", "03-viidure", "viidure_ts", "viidure_basic.ts",
         {"format": "viidure", "points": 40},
         {"seed": 50, "records_per_pes": 1,
          "track": {"start": "2026/04/16 01:01:02", "n": 40, "nofix_prefix": 0,
                    "lat0": 42.211424, "lon0": -88.320975, "speed_kmh": 89.1}}),
    case("viidure_multi_per_pes", "03-viidure", "viidure_ts", "viidure_multi_per_pes.ts",
         {"format": "viidure", "points": 60},
         {"seed": 51, "records_per_pes": 5,
          "track": {"start": "2026/04/17 01:01:02", "n": 60, "nofix_prefix": 0,
                    "lat0": 42.5, "lon0": -88.1, "speed_kmh": 70.0}}),

    # -- format D ----------------------------------------------------------------------
    case("nmea_rmc_gga", "04-nmea", "nmea_ts", "nmea_rmc_gga.ts",
         {"format": "nmea", "points": 50},
         {"seed": 60, "sentences_per_pes": 4,
          "track": {"start": "2026/05/01 10:00:00", "n": 50, "nofix_prefix": 0,
                    "lat0": 47.6, "lon0": -122.3, "speed_kmh": 65.0}}),
    case("nmea_rmc_only", "04-nmea", "nmea_ts", "nmea_rmc_only.ts",
         {"format": "nmea", "points": 30},
         {"seed": 61, "gga": False, "sentences_per_pes": 3,
          "track": {"start": "2026/05/02 10:00:00", "n": 30, "nofix_prefix": 0,
                    "lat0": 47.6, "lon0": -122.3, "speed_kmh": 65.0}}),
    case("nmea_bad_checksum", "04-nmea", "nmea_ts", "nmea_bad_checksum.ts",
         {"format": "nmea", "points": 24},
         {"seed": 62, "corrupt_every": 5, "sentences_per_pes": 4,
          "track": {"start": "2026/05/03 10:00:00", "n": 30, "nofix_prefix": 0,
                    "lat0": 47.6, "lon0": -122.3, "speed_kmh": 65.0}}),
    case("nmea_gga_only", "04-nmea", "nmea_ts", "nmea_gga_only.ts",
         {"format": None, "points": 0},
         {"seed": 63, "rmc": False, "sentences_per_pes": 3,
          "track": {"start": "2026/05/04 10:00:00", "n": 20, "nofix_prefix": 0}}),
    case("nmea_mp4_free", "04-nmea", "nmea_mp4", "nmea_mp4_free.mp4",
         {"format": "nmea", "points": 40},
         {"seed": 64,
          "track": {"start": "2026/05/05 10:00:00", "n": 40, "nofix_prefix": 0,
                    "lat0": 34.05, "lon0": -118.24, "speed_kmh": 55.0}}),

    # -- negative cases ----------------------------------------------------------------
    case("neg_empty", "00-model", "raw", "neg_empty.ts", {"format": None, "points": 0},
         {"kind": "empty"}),
    case("neg_tiny", "00-model", "raw", "neg_tiny.ts", {"format": None, "points": 0},
         {"kind": "tiny"}),
    case("neg_noise", "00-model", "raw", "neg_noise.ts", {"format": None, "points": 0},
         {"seed": 70, "kind": "noise", "bytes": 8192}),
    case("neg_mp4_nogps", "00-model", "raw", "neg_mp4_nogps.mp4",
         {"format": None, "points": 0}, {"seed": 71, "kind": "mp4_nogps"}),
]


def main(argv):
    check = "--check" in argv
    os.makedirs(BIN, exist_ok=True)
    os.makedirs(CASES, exist_ok=True)
    manifest = {}
    for c in CASE_LIST:
        data = BUILDERS[c["builder"]](c["params"])
        path = os.path.join(BIN, c["output"])
        with open(path, "wb") as f:
            f.write(data)
        with open(os.path.join(CASES, c["id"] + ".json"), "w", newline="") as f:
            f.write(json.dumps(c, indent=2, sort_keys=False) + "\n")
        manifest[c["output"]] = {
            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
        }
        if not check:
            sys.stderr.write("  %-40s %8d bytes\n" % (c["output"], len(data)))
    with open(os.path.join(HERE, "manifest.json"), "w", newline="") as f:
        f.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    sys.stderr.write("%d fixtures\n" % len(CASE_LIST))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

# Provenance and licensing

dashgps is MIT licensed. Keeping it that way requires care about where format knowledge comes
from, because most prior art in this space is GPL or Artistic licensed.

## How each format was derived

| Format | Derivation |
|---|---|
| `ligo.ts_trailer` | Reverse-engineered from ~1,230 files we own, by direct inspection of the byte stream. Confirmed against the vendor's own player output. |
| `ligo.plain` | Same record grammar as above, relocated. Same derivation. |
| `viidure` | Implemented from a sample record published in a public bug report. A single ASCII line of data is a fact, not copyrightable expression. |
| `nmea` | NMEA 0183 is a published industry standard. |

The vendor player (`gpsplayer.exe`, `sunningsoftGps.dll`) was examined only for printf-style format
strings visible in its read-only data section, which corroborated a field grammar we had already
recovered from the data itself. No code was decompiled into dashgps.

## Relationship to ExifTool

[ExifTool](https://exiftool.org/) is the most complete tool in this space — it reads 124 kinds of
timed GPS metadata — and dashgps is not trying to replace it. ExifTool is licensed under the Perl
Artistic License / GPL.

**No ExifTool source code has been copied, ported, translated or consulted while implementing any
dashgps parser.** ExifTool is not vendored, not bundled, and not a dependency. The Python CLI can
invoke a user's own installed `exiftool` as a subprocess and read its JSON *output* — data, not
code — and that path is off by default and clearly labelled in the summary as external.

Where our research notes cite ExifTool, they cite it the way one cites a paper: as evidence that a
format exists and roughly how it behaves. `spec/01-ligogps-ts-trailer.md` §1.9 describes two
concrete bugs in its handling of our format, which we intend to report upstream.

## Contributing code

Every pull request carries a checkbox:

> I did not copy or consult source code from ExifTool or any other GPL- or Artistic-licensed
> project while writing this.

Maintainers will remove and rewrite any contribution whose provenance is unclear. If you know a
format because you read GPL source, please open an issue describing the *behaviour* instead of
sending a patch, and let someone else implement it from your description.

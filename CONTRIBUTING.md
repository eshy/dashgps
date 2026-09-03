# Contributing to dashgps

## The most useful thing you can send us

A **diagnostic** from a camera we do not support:

```console
$ dashgps inspect --redact --hexdump YOURFILE.ts
```

Paste that into a [new-format issue](https://github.com/dashgps/dashgps/issues/new?template=new-format.yml).
It is usually enough to identify the format.

**Please do not attach a raw dashcam file.** Its coordinates include wherever you drove, which for
most people means their home address. If we need real bytes we will ask, and there is a way to send
only the metadata region:

```console
$ dashgps inspect --hexdump YOURFILE.ts > report.txt      # check it before sending
```

For a formats whose data is at the end of the file, the last megabyte contains the GPS log and
essentially no video. We will tell you exactly which bytes we need, and you can look at them first.

## Development setup

No dependencies, no build step.

```console
$ git clone https://github.com/dashgps/dashgps && cd dashgps
$ python3 fixtures/build_fixtures.py          # regenerate the synthetic fixtures
$ cd python/tests && python -m unittest discover -s .
$ cd js && node --test test/*.test.js
$ ./scripts/parity.sh                         # both cores, byte-for-byte
$ node scripts/build_web.mjs && python3 -m http.server -d web/dist
```

## Adding a format

The order matters. Writing the spec first is what stops a parser from becoming the only description
of the format, and it is also how we keep the project's provenance clean.

1. **Write `spec/NN-yourformat.md`** — a byte-layout table, a numbered parse algorithm, a
   Provenance section saying how you learned this, and a Conformance table.
2. **Add fixture cases** to `fixtures/build_fixtures.py`: a happy path, the edge cases your spec
   mentions, and at least one negative case so the format cannot false-positive on noise.
3. `python3 fixtures/build_fixtures.py && ./scripts/regen_golden.sh`
4. **Implement it twice**, `python/src/dashgps/formats/` and `js/src/formats/`, as file-for-file
   mirrors, citing your spec's clause numbers in comments.
5. **Register it in the same position** in `formats/__init__.py` and `formats/index.js`.
   Registration order breaks ties between formats and is part of the spec.
6. **Declare its IO cost honestly** — `tail`, `head` or `full-scan`. The test suite enforces the
   budget. A format that lies about its cost destroys the performance promise for every user.
7. Update the README table and `CHANGELOG.md`.

### Status

Set `STATUS` to what is true:

| Status | Means |
|---|---|
| `verified` | Run against real files from that camera, in quantity, with the result checked against something independent. |
| `reverse-engineered` | Derived from a real artifact, not confirmed end to end. |
| `untested` | Built from a published sample or a public standard. Never seen a real file. |

Do not promote a format because the code looks right. `verified` is a claim about evidence.

## The rules that protect output parity

`spec/30-formatting.md` is the contract. In `python/src/dashgps/` and `js/src/`:

- **No built-in number, date or JSON formatter.** No `toFixed`, `round()`, `datetime`,
  `new Date()`, `JSON.stringify`, `json.dumps`, `%.3f`, f-string precision. Use the helpers in
  `fmt`. `scripts/check_determinism.py` fails the build otherwise; a line may opt out with a
  `deterministic-ok: <reason>` comment.
- **No default sort.** Python sorts by code point, JavaScript by UTF-16 code unit; they disagree
  above the BMP. Use `byte_key` / `cmpNames`.
- **No regular expressions in record parsers.** The grammars are positional, and hand-written
  tokenizers are easier to keep identical across two languages.
- **The two trees mirror each other**, module for module and function for function. A reviewer
  should be able to read them side by side.

## Provenance

dashgps is MIT licensed and intends to stay that way. Most prior art in this space is GPL or
Artistic licensed, so every pull request carries this checkbox:

> I did not copy or consult source code from ExifTool, or any other GPL- or Artistic-licensed
> project, while writing this.

If you know a format *because* you read GPL source, that is genuinely useful — please open an issue
describing the **behaviour** (magic bytes, offsets, field meanings) and let someone else implement
it from your description. Maintainers will remove and rewrite anything of unclear provenance.

See [`NOTICE.md`](NOTICE.md).

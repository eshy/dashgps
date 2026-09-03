## What this changes

<!-- One or two sentences. -->

## Checklist

- [ ] I did not copy or consult source code from ExifTool, or any other GPL- or
      Artistic-licensed project, while writing this. (See `NOTICE.md`. If you know a format
      because you read GPL source, please open an issue describing the *behaviour* instead.)
- [ ] `python3 scripts/check_determinism.py --self-test` passes.
- [ ] Both suites pass: `cd python/tests && python -m unittest discover -s .` and
      `cd js && node --test`.
- [ ] `./scripts/parity.sh` passes.

## If this adds or changes a format

- [ ] `spec/` has a document for it, written before the parser, with a Conformance table.
- [ ] There is at least one fixture case, and negative cases where the format could false-positive.
- [ ] Both cores implement it, and it is registered in the same position in each.
- [ ] Its `status` is honest: `verified` only if it has been run against real files from that
      camera, in quantity.

## If any golden output changed

Goldens are byte-exact by design, so a diff here is a behaviour change. Explain what changed and
why it is correct:

<!-- ... -->

# Releasing

Publishing is a one-way door: PyPI and npm both keep a name once it is claimed, and a version
number can never be reused even after a deletion. Everything below is arranged so the irreversible
step happens last, from CI, with no long-lived credential in existence.

## Once, when the repo is created

1. Create the GitHub repository and push. **Done** — <https://github.com/eshy/dashgps>.
2. **Settings → Pages → Source: GitHub Actions.** That is the only setting; do **not** use either
   "Configure" card on that page — they add a second, competing workflow, and this repo already
   has `.github/workflows/pages.yml`. If Pages was switched on after the first push, that run had
   nothing to deploy into: re-run it from **Actions → pages → Run workflow**. The site lands at
   <https://eshy.github.io/dashgps/>.
3. **PyPI → Publishing → Add a pending publisher** (Trusted Publishing), with:
   - PyPI project name: `dashgps`
   - Owner / repository: `eshy` / `dashgps`
   - Workflow: `release.yml`
   - Environment: `release`
4. **GitHub → Settings → Environments → New environment: `release`.** Add required reviewers if
   you want a human approval in front of every publish.
5. **npm.** npm has trusted publishing too, but with one catch PyPI does not have: a trusted
   publisher can only be configured on a package that **already exists**, so the very first
   version cannot go out over OIDC ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).

   Publish `0.1.0` once, by hand, from your own machine — no token needs to exist at all:

   ```console
   $ npm login                 # interactive, uses your 2FA
   $ cd js && npm publish --provenance --access public
   ```

   Then at <https://www.npmjs.com/package/dashgps/access>:
   - **Trusted publisher → GitHub Actions**, with owner `eshy`, repository `dashgps`,
     workflow `release.yml`, environment `release`, allowed action `npm publish`.
   - **Publishing access → "Require two-factor authentication and disallow tokens."** Trusted
     publishing keeps working (it uses OIDC, not a token) and this shuts the token door for good.

   Every release after `0.1.0` then publishes from CI with no credential. `release.yml` skips the
   npm step automatically if that version is already on the registry, so the `v0.1.0` tag is safe
   to push after the manual publish.

   Requirements the workflow already handles: npm CLI >= 11.5.1 (Node 22 bundles an older one, so
   it upgrades first) and a `repository.url` in `package.json` that exactly matches the configured
   publisher.

## Every release

```console
$ ./scripts/parity.sh && (cd python/tests && python -m unittest discover -s .)
$ $EDITOR CHANGELOG.md
$ echo 0.1.1 > VERSION
$ $EDITOR python/pyproject.toml js/package.json python/src/dashgps/__init__.py js/src/index.js
$ python3 scripts/check_version.py        # refuses if the five disagree
$ git commit -am "Release 0.1.1" && git tag v0.1.1 && git push --follow-tags
```

The tag fires `release.yml`, which runs the **entire** CI gate first — tests in both languages on
three operating systems, the byte-for-byte parity diff, the determinism and packaging guards, and
an actual build-and-install of both distributions checked against the golden output — and only then
publishes. The tag must match `VERSION` or it stops.

## Publishing by hand

Only if CI is unavailable. Use TestPyPI first; it is the one place a mistake is free.

```console
$ python -m build python/ --outdir dist/
$ twine check --strict dist/*
$ twine upload --repository testpypi dist/*
$ pip install --index-url https://test.pypi.org/simple/ --no-deps dashgps && dashgps --version
$ twine upload dist/*
```

Prefer a short-lived, project-scoped API token, and revoke it immediately afterwards. A token that
can publish `dashgps` can publish anything under that account unless it is scoped. For npm, prefer
`npm login` over a token entirely — it is interactive, uses your 2FA, and leaves nothing behind.

## Before the first release

- [ ] The GitHub repository exists and the README links resolve. **Done** — `eshy/dashgps`.
- [ ] `dashgps` is still free on PyPI and npm. **Checked 2026-09-03**: PyPI 404, npm registry 404.
- [ ] PyPI pending publisher configured; GitHub `release` environment created.
- [ ] npm `0.1.0` published by hand, then its trusted publisher configured.
- [ ] Someone has run the tool against real footage from a camera we do not own, or the README's
      status column is the only thing standing between a user and a wrong track. It already is —
      keep it honest.

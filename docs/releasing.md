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
   $ cd js && npm pack --dry-run    # check what will ship
   $ npm publish --access public
   ```

   **No `--provenance` here.** Provenance attestations are signed with an OIDC identity that only
   a supported CI provider can issue; run it on a laptop and npm fails with
   `Automatic provenance generation not supported for provider: null`. The flag belongs in
   `release.yml`, where it works — so `0.1.0` is the one version without an attestation, and every
   release after it has one.

   Then at <https://www.npmjs.com/package/dashgps/access>:
   - **Trusted publisher → GitHub Actions**, with owner `eshy`, repository `dashgps`,
     workflow `release.yml`, environment `release`, and allowed action **`npm stage publish`
     only** — not `npm publish`. See "Why staged" below.
   - **Publishing access → "Require two-factor authentication and disallow tokens."** Trusted
     publishing keeps working (it uses OIDC, not a token) and this shuts the token door for good.

   Every release after `0.1.0` is then staged from CI with no credential. `release.yml` skips the
   npm step if that version is already on the registry, so the `v0.1.0` tag is safe to push after
   the manual publish.

   Requirements the workflow already handles: npm CLI >= 11.15.0 (OIDC needs 11.5.1, staging needs
   11.15.0; Node 22 bundles an older one, so the job upgrades first) and a `repository.url` in
   `package.json` that exactly matches the configured publisher.

### Why staged

`npm stage publish` submits the tarball to a staging area instead of the registry. Nothing is
installable until a maintainer approves it with 2FA. The point is the blast radius: with plain
`npm publish` allowed, anything able to trigger the release workflow — a bad merge, a compromised
action, a mistaken tag — puts code straight onto the registry, where a version can never be reused
even after being unpublished. Staged, the worst case is a queued release that a human declines.

The trade is one manual step per release, described below.

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

PyPI goes live at that point. **npm does not**: it is staged, and waits for you.

```console
$ npm stage list dashgps          # find the stage id
$ npm stage view <stage-id>       # what exactly is in it
$ npm stage download <stage-id>   # optional: inspect the tarball itself
$ npm stage approve <stage-id>    # 2FA; this is the moment it goes live
```

or press **Approve** on <https://www.npmjs.com/package/dashgps/access>. `npm stage reject
<stage-id>` throws it away instead — the only stage in this pipeline where a mistake is still
recoverable, so it is worth actually looking before approving.

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

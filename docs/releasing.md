# Releasing

Publishing is a one-way door: PyPI and npm both keep a name once it is claimed, and a version
number can never be reused even after a deletion. Everything below is arranged so the irreversible
step happens last, from CI, with no long-lived credential in existence.

## Once, when the repo is created

1. Create the GitHub repository and push. Nothing published references anything until this exists —
   both READMEs, `pyproject.toml` and `package.json` point at
   `https://github.com/dashgps/dashgps`, and those links are dead until it does.
2. **Settings → Pages → Source: GitHub Actions.** The `pages` workflow deploys the browser tool
   and the single-file build on every push to `main`.
3. **PyPI → Publishing → Add a pending publisher** (Trusted Publishing), with:
   - PyPI project name: `dashgps`
   - Owner / repository: your org / `dashgps`
   - Workflow: `release.yml`
   - Environment: `release`
4. **GitHub → Settings → Environments → New environment: `release`.** Add required reviewers if
   you want a human approval in front of every publish.
5. npm has no equivalent of Trusted Publishing for this flow, so it needs a token: create an
   **automation** token scoped to the package and add it as the `NPM_TOKEN` repository secret.

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
can publish `dashgps` can publish anything under that account unless it is scoped.

## Before the first release

- [ ] The GitHub repository exists and the README links resolve.
- [ ] `dashgps` is still free on PyPI and npm.
- [ ] Someone has run the tool against real footage from a camera we do not own, or the README's
      status column is the only thing standing between a user and a wrong track. It already is —
      keep it honest.

# Homebrew cask (release step)

SparkDown's cask lives in [sparkdown/homebrew-tap](https://github.com/sparkdown/homebrew-tap)
(`Casks/sparkdown.rb`). Users install with `brew install --cask sparkdown/tap/sparkdown`.

## Bumping on a release

After a real `v<version>` release is published **and** its `SparkDown_<version>_aarch64.dmg`
asset is uploaded (the Mac build is made locally, see `scripts/release.sh`), run:

```bash
bash scripts/bump-cask.sh <version>          # opens a PR on the tap
bash scripts/bump-cask.sh <version> --direct # or commit straight to the tap
```

The script downloads the published dmg, hashes it, rewrites `version` and `sha256`, and
pushes. It never touches releases. The tap's CI (`brew style`, `brew audit`, real
install + `uninstall --zap` on macos-latest) must be green before merging.

Do not bump before the dmg is on the release: the cask URL would 404.

## Automating it

Not automated yet: no secret with write access to `sparkdown/homebrew-tap` exists in this
repo (the default `GITHUB_TOKEN` can't push cross-repo). To automate, add a repo secret
such as `HOMEBREW_TAP_TOKEN` (fine-grained PAT or GitHub App token scoped to
`sparkdown/homebrew-tap`, Contents + Pull requests: read/write) and a workflow triggered
on `release: published` for `v*` tags that runs `GH_TOKEN=${{ secrets.HOMEBREW_TAP_TOKEN }} bash scripts/bump-cask.sh ${GITHUB_REF_NAME#v}`.
Because the Mac dmg is uploaded by hand after the release is created, that job would need
to wait for (or retry until) the dmg asset exists.

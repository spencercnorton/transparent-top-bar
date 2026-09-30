# Contributing to Transparent Top Bar (Auto)

Thanks for your interest. This is a small project with one maintainer, so the
process is deliberately light.

## How changes land

GitHub is the development home. Branch from `main` and open a pull request
into `main`. The checks must pass before merge. Changes ship in tagged
releases.

Use a GitHub noreply address for commit authorship if you prefer to keep your
personal address private. Public history is public data.

## Working on the code

```bash
make test                           # what CI runs
scripts/build.sh                    # build the release zip and .deb
```

- Test a change in a real GNOME Shell session, and say which version in the
  pull request. `scripts/smoke.mjs` stubs GNOME Shell, so it catches leaked
  signals and sources, not real rendering.
- A change that belongs in the original extension is best offered upstream
  too.
- Keep a change to one concern.
- Commits carry a `Signed-off-by:` line (`git commit -s`, the Developer
  Certificate of Origin). There is no CLA.
- No secrets, hostnames, personal data or personal paths in the diff; the
  privacy check rejects them.

## Out of scope

- Styling anything other than the top bar.
- Sending the wallpaper, or anything measured from it, anywhere.

## Pull request checklist

- [ ] `make test` passes
- [ ] Tested in GNOME Shell (say which version)
- [ ] Commits are signed off
- [ ] `CHANGELOG.md` updated under `## Unreleased` if behaviour changed

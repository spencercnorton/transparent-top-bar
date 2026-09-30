<h1 align="center">Transparent Top Bar (Auto)</h1>

<p align="center">
  <strong>A transparent top bar that stays readable on any wallpaper.</strong><br>
  A GNOME Shell extension that sets the top bar's opacity from the wallpaper behind it: the lowest opacity at which the panel text still reaches 4.5:1 contrast.
</p>

<p align="center">
  <a href="https://github.com/spencercnorton/norvi-os"><img alt="Part of NorviOS" src="https://img.shields.io/badge/NorviOS-component-FD8024.svg"></a>
  <a href="https://github.com/spencercnorton/transparent-top-bar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/spencercnorton/transparent-top-bar/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/spencercnorton/transparent-top-bar/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/spencercnorton/transparent-top-bar?label=release&sort=semver"></a>
  <a href="#install"><img alt="Install for GNOME Shell" src="https://img.shields.io/badge/install-GNOME%20Shell-4a86cf.svg"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/badge/licence-GPL--2.0--or--later-blue.svg"></a>
  <a href="https://buy.stripe.com/8x26oH2U44f65TRe574wM04"><img alt="Donate" src="https://img.shields.io/badge/donate-Stripe-635bff.svg?logo=stripe&logoColor=white"></a>
</p>

<p align="center">
  <img alt="The NorviOS desktop: a transparent top bar with named workspaces on the left and the weather and clock on the right, over a colourful wallpaper, above a Files window rendered as frosted glass." src="https://raw.githubusercontent.com/spencercnorton/norvi-os/main/docs/screenshots/desktop.png" width="900">
</p>

The screenshot is the [NorviOS](https://github.com/spencercnorton/norvi-os) desktop on a fresh Ubuntu 26.04 virtual machine with a demo account and a generated wallpaper.

A fork of [Transparent Top Bar](https://github.com/lamarios/gnome-shell-extension-transparent-top-bar) by Paul Fauchon, itself based on Hai Zhang's extension of the feature GNOME Shell 3.32 removed. Where the original uses one fixed opacity, this version measures the wallpaper and picks the opacity itself. It supports GNOME Shell 50 and 51.

## What it does

**Measures the wallpaper behind the panel.** It samples the strip of the wallpaper that sits under the top bar, including a wallpaper spanned across several monitors, and plans against its brightest 5 per cent rather than its average. A bright patch behind the clock therefore counts.

**Picks the lowest opacity that keeps the text readable.** It uses WCAG AA, 4.5:1 for the panel text, within a minimum and maximum you set in the preferences. When the wallpaper changes, it measures again. A needed increase applies at once; a cosmetic decrease waits until it is worth a cross-fade.

**Behaves like the original otherwise.** The bar turns solid under a maximised or fullscreen window, and the text shadow can be switched off. The original fixed opacity is still available with the automatic mode turned off.

**Respects accessibility settings.** High contrast makes the bar opaque, and reduced motion changes the opacity without animating.

## Install

### GNOME Shell — the release zip

Download `transparent-top-bar.shell-extension.zip` and `SHA256SUMS.txt` from the [latest release](https://github.com/spencercnorton/transparent-top-bar/releases/latest), then:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt
gnome-extensions install --force transparent-top-bar.shell-extension.zip
```

Log out and back in once so GNOME Shell sees the new extension, then enable it and open its preferences:

```bash
gnome-extensions enable transparent-top-bar@spencercnorton.github.io
gnome-extensions prefs transparent-top-bar@spencercnorton.github.io
```

### Ubuntu 26.04 — the release package

The same release carries `gnome-shell-extension-transparent-top-bar_*_all.deb`, which installs the extension for every user and its settings schema system-wide. Install it with `sudo apt install ./gnome-shell-extension-transparent-top-bar_*_all.deb`, then log out and in and enable it as above.

### From source

```bash
sudo apt install sassc libglib2.0-bin zip nodejs python3
make install          # tests, builds dist/, installs the zip for your user
```

The upstream extension uses a different UUID and settings schema, so this one installs alongside it. Enable only one of them.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): one entry per release
- [NOTICE](NOTICE): provenance and licence

## Configuration

The preferences window sets the automatic mode and its minimum and maximum opacity, the fixed opacity used when the automatic mode is off, the solid bar under maximised windows, and the text shadow. The settings live in dconf under `/org/gnome/shell/extensions/transparent-top-bar/`; `auto-last-opacity` is only a cache of the last measurement.

The extension reads the wallpaper file named in GNOME's own background settings, and nothing leaves the machine.

## Contributing and support

- Bugs and feature requests: [open an issue](https://github.com/spencercnorton/transparent-top-bar/issues/new/choose). Questions: [Discussions](https://github.com/spencercnorton/transparent-top-bar/discussions).
- Security reports: [private vulnerability reporting](https://github.com/spencercnorton/transparent-top-bar/security/advisories/new). See [SECURITY.md](SECURITY.md). There is no e-mail address; that is deliberate.
- Pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Changes are reviewed and merged on GitHub, then shipped in tagged releases.
- If this saves you time, you can [support its development](https://buy.stripe.com/8x26oH2U44f65TRe574wM04).

## Development

```bash
make test             # what CI runs: the opacity maths, enable/disable against stubbed GNOME APIs, release invariants
scripts/build.sh      # the release zip and .deb, into dist/
```

## Licence

[GPL-2.0-or-later](LICENSE), inherited from upstream.

This fork is based on [lamarios/gnome-shell-extension-transparent-top-bar](https://github.com/lamarios/gnome-shell-extension-transparent-top-bar) at `74b3ae8`, whose history this repository keeps unchanged. The fork's changes are © Spencer Norton under the same licence. See [NOTICE](NOTICE).

# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/spencercnorton/transparent-top-bar/security/advisories/new)**.
Do not open a public issue, and do not include real credentials or personal
paths in the report — a description and a minimal reproduction are enough.

There is no e-mail address for security reports; the advisory form is the
only channel, and it is the one that is monitored. You will get an
acknowledgement within a week. Fixes ship as a tagged release; the advisory
is published once the release is out, and credits you unless you ask
otherwise.

## Supported versions

Only the latest tagged release is supported.

## What the extension does

It runs inside GNOME Shell. It reads the wallpaper file that GNOME's own
background settings name, to measure its brightness, and stores its settings
and the last measured opacity in dconf. It opens no network connections and
handles no credentials. A wallpaper file is decoded with GdkPixbuf, so a
malformed image is a GdkPixbuf problem first; report it here all the same.

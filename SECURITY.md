# Security Policy

## Supported versions

The latest release on `main` is the supported version.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisories](https://github.com/Nurkan1/Universe-3D-Linux/security/advisories/new)
rather than in a public issue.

Include the affected version, what an attacker could achieve, and steps to
reproduce. You can expect an initial response within a few days.

## Security model

Universe 3D launches programs on the user's behalf, so these are the paths that
matter:

**Application launching.** A `.desktop` file's `Exec=` line is parsed into
`argv` following the XDG Desktop Entry specification and executed directly,
never through a shell. Shell metacharacters in an untrusted entry become
literal arguments instead of a second command. This is covered by unit tests in
`src-tauri/src/main.rs`.

**The command launcher** deliberately runs its input through a shell — accepting
shell syntax is the point of the feature. It requires an explicit confirmation
showing the exact command first.

**The webview** runs under a restrictive Content-Security-Policy with
`withGlobalTauri` disabled, so page scripts cannot reach `invoke` through a
browser global. The Tauri capability set is limited to the window operations
and the global shortcut the app actually uses.

**Network.** The application makes no network requests. All assets are bundled
locally and the CSP forbids remote origins.

**Data.** Preferences are stored in `~/.config/universe-3d/prefs.json` and the
icon cache in `~/.cache/universe-3d/`. Nothing is transmitted anywhere.

## Known advisories

`glib` 0.18.5 is pulled in transitively through the pinned gtk-rs 0.18 stack
that Tauri depends on for Linux, and is affected by
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
(unsoundness in `VariantStrIter`). This project does not use the affected API,
and the version cannot be raised until Tauri migrates to gtk-rs 0.20.

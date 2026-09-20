# Changelog

## [1.2.1] - 2026-09-20

Catalog rebuilds and publication now run independently of settings-page deployment and watch releases.

Active works now participate in traffic reporting according to their severity, rather than being discarded solely because their cause is `TRAVAUX`. Future, expired, and information-only notices remain excluded.

### Fixes

- fix(traffic): include active works in disruption selection (`a259698`)

### Changes

- chore(release): bump to version 1.2.1 (`66c22cf`)
- ci(catalog): separate catalog publishing from release deployment (`8f2b8fe`)

## [1.2.0] - 2026-09-20

The configuration page can now override the watch app language independently of the watch system settings. Automatic remains the default; explicit French or English choices are saved on the phone and survive restarts.

If saving a replacement credential fails, the previous language and favorites remain active.

### Features

- feat(configuration): add persistent watch language selection (#30) (#31) (`1650944`)

### Changes

- chore(release): bump version to 1.2.0 and update changelog

## [1.1.0] - 2026-09-19

Favorites now pair a departure stop and line with a reachable arrival stop, including intermediate stops. Available across all five transport modes, journeys stay on one line without connections. The configuration page lets you select the arrival stop. The watch combines full-line and short-turn departures chronologically, excludes services known not to reach your arrival stop, and marks uncertain journeys with `?` without changing their departure times.

Traffic information selects the most recently updated active incident rather than the most severe one. Works, future incidents, and expired incidents are excluded. If the selected English message lacks a usable title or body, the complete French message for the same incident is used instead.

Departure-to-arrival favorites require rebuilding and publishing the catalog with journey patterns.

### Features

- feat(arrivals): support departure-to-arrival favorites (#28) (#29) (`102d719`)

### Fixes

- fix(traffic): show the latest active incident and exclude works (`6ae56e9`)

### Changes

- chore(release): prepare 1.1.0 with changelog-based release notes

## [1.0.4] - 2026-09-14

This release fixes partial-service arrival pooling in the companion and relocates store assets. The documentation also clarifies stop and arrival terminology.

### Changes

- chore(release): bump version to 1.0.4 (`bd3b82f`)
- docs: clarify stop and arrival terminology (`59caea0`)

### Fixes

- fix(companion): pool partial-service arrivals and move store assets (`2635f28`)

**Full changelog**: https://github.com/Anthodev/lapin-fute/compare/v1.0.3...v1.0.4

[Release v1.0.4](https://github.com/Anthodev/lapin-fute/releases/tag/v1.0.4)

## [1.0.3] - 2026-09-14

This release clarifies stop and arrival terminology in the interface (#27).

### Fixes

- fix(ui): clarify stop and arrival terminology (#27) (`8835364`)

**Full changelog**: https://github.com/Anthodev/lapin-fute/compare/v1.0.2...v1.0.3

[Release v1.0.3](https://github.com/Anthodev/lapin-fute/releases/tag/v1.0.3)

## [1.0.2] - 2026-09-13

Line badges on the watch now carry a metro or tram prefix, so metro and tram lines are distinguishable at a glance (#24, #25). Release notes generation handles squash merges correctly, and the README is refreshed.

### Features

- feat(display): prefix metro and tram line labels on watch badges (#24) (#25) (`0cc3c0b`)

### Changes

- chore(docs): updated README.md (`1889044`)

### Fixes

- fix(release): handle squash merges when generating release notes (`9e36c16`)

**Full changelog**: https://github.com/Anthodev/lapin-fute/compare/v1.0.1...v1.0.2

[Release v1.0.2](https://github.com/Anthodev/lapin-fute/releases/tag/v1.0.2)

## [1.0.1] - 2026-09-13

Store readiness and polish rather than features. Departure detail spacing is balanced on both Emery and Gabbro, including the header, countdown, and separator framing. Publishing to RePebble now runs as a separate job after the GitHub release, with renewable Firebase authentication and artifact, ownership, and version checks, and release titles use version tags. Screenshots are refreshed, the MIT license lands in the repository and package metadata, and the configuration page About text and RePebble badge are updated to 1.0.1.

### Fixes

- Balance departure detail screen spacing on Emery and Gabbro, including the header, countdown, and Emery separator framing.

### Release tooling

- Publish the validated PBW to RePebble in a separate job after the GitHub release, using renewable Firebase authentication and artifact, ownership, and version checks.
- Use version tags as GitHub release titles.

### Documentation and metadata

- Refresh departure screenshots for Emery and Gabbro and simplify README badges.
- Add the MIT license and package license metadata.
- Update package versions, configuration-page About text, and the RePebble badge to 1.0.1.
- Document Store publishing setup and remove completed release planning documents.

**Full changes between release snapshots**: https://github.com/Anthodev/lapin-fute/compare/v1.0.0..v1.0.1

[Release v1.0.1](https://github.com/Anthodev/lapin-fute/releases/tag/v1.0.1)

## [1.0.0] - 2026-09-13

First public release. Lapin Futé puts Île-de-France arrivals on a Pebble watch: the companion fetches live PRIM departures and normalizes them phone-side (#12), a bounded importer resolves the IDFM service catalog (#11), and the watch renders only what the phone prepares (#17). Favorites persist and synchronize (#14), a configuration page runs on the phone (#13), settings are modernized with app branding (#19), and stale and failure handling is hardened (#20). The CI pipeline packages the PBW, verifies deploys with rollback rehearsal, and skips unchanged catalog uploads. Store icons, screenshots, and banner ship with the release.

### Features

- feat: verify published configuration site (`9dc8049`)
- feat: harden stale and failure handling (#20) (`835b18b`)
- feat(companion): modernize settings and introduce app branding (#19) (`2799b0f`)
- feat: migrate to phone-only data and phone-prepared watch displays (#17) (`a46bf24`)
- feat: deliver Pebble watch consultation (#15) (`aabca5b`)
- feat: persist and synchronize favorites (#14) (`5ff79d1`)
- feat: build companion configuration page (#13) (`f7d01bd`)
- feat: normalize live PRIM departures (#12) (`5a0b437`)
- feat: establish Alloy app foundation (#10) (`ffd859a`)

### Changes

- docs: link published RePebble release (`de5dd7f`)
- chore: add RePebble store screenshots and banner (`e008516`)
- chore: add RePebble store icons (`646389f`)
- docs: streamline project overview and controls (`3e430d6`)
- docs: add v1 release checklist (`d6184a2`)
- docs: research official v1 release requirements (`30a8f4c`)
- chore: ignore Pebble build lock (`6b61693`)
- chore: set release version to 1.0.0 (`e1d539d`)
- Resolve IDFM service catalog with bounded importer (#11) (`acf5bba`)
- chore: initialize develop branch (`4c1dead`)

### Fixes

- fix: normalize Emery store screenshot brightness (`befc545`)
- fix: close release verification gaps (`457bcb9`)

### CI

- ci: skip unchanged catalog uploads (`91a4982`)
- ci: retain and rehearse deployment rollback (`5f1ff8c`)
- ci: package PBW release assets (`30f04fc`)
- ci: verify deploys and restore failures (`f224ada`)

**Full changelog**: https://github.com/Anthodev/lapin-fute/commits/v1.0.0

[Release v1.0.0](https://github.com/Anthodev/lapin-fute/releases/tag/v1.0.0)

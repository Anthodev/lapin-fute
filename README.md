<p align="center">
  <img src="packages/config-page/assets/lapin-fute-1024.png" alt="Lapin Futé icon" width="96">
</p>

<h1 align="center">Lapin Futé</h1>

<p align="center">
  <strong>Next departures and line traffic at a glance, on your Pebble.</strong>
  <br>
  Keep six favorite stops across Île-de-France and check them without reaching for your phone.
</p>

<p align="center">
  <a href="https://apps.repebble.com/6d6aa01b7ecb4cfea469a183">Get Lapin Futé</a>
  · <a href="#features">Features</a>
  · <a href="#compatibility">Compatibility</a>
  · <a href="#getting-started">Getting started</a>
  · <a href="#watch-controls">Watch controls</a>
  · <a href="#privacy">Privacy</a>
  · <a href="#build-from-source">Build from source</a>
  · <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Pebble-emery%20%7C%20gabbro-00A5E0" alt="Pebble emery and gabbro">
  <img src="https://img.shields.io/badge/Language-EN%20%7C%20FR-00A5E0" alt="English and French">
  <a href="https://apps.repebble.com/6d6aa01b7ecb4cfea469a183"><img src="https://img.shields.io/badge/RePebble-v1.0.1-FF4938" alt="Lapin Futé 1.0.1 on RePebble"></a>
</p>

## About

Lapin Futé puts Île-de-France public-transport departures on a Pebble watch. The watch shows a list of favorites with the next departures, a departure board per favorite, and the current service messages for its line. A companion on your phone fetches the data from PRIM, Île-de-France Mobilités' open-data platform, and prepares everything the watch displays; the watch itself never goes online.

## Features

- **Six favorites, five transport modes.** Choose any stop, line, and direction across Métro, RER, Transilien, Tram, and Bus. Favorites are renamed and reordered on the phone page, which shows official line badges and colors.
- **Departures at a glance.** The favorites list already shows the next departures for each stop; Select opens a full board for one favorite. Countdowns keep ticking on the watch between refreshes.
- **Traffic view.** Select again on a departure board to page through the current service messages for that line.
- **Refresh when needed.** Open the app, switch favorite, choose Refresh all, or hold Select to request departures. Recent results are reused for 60 seconds; after a failed refresh, the last complete result remains visibly stale for at most 15 minutes. There is no periodic network polling.
- **Clear data states.** The app distinguishes real-time departures, mixed real-time and scheduled results, updates in progress, and missing cached data.
- **English and French.** The watch interface and the settings page are both bilingual.
- **Settings that fit your phone.** Light and dark themes follow your system preference. Collapsible sections keep favorite editing, PRIM access, and watch synchronization easy to reach.

## Compatibility

| Requirement | Details |
|---|---|
| Watches | Pebble Time 2 (emery profile, primary target); the Pebble Round 2 profile is experimental |
| Firmware | 4.32 or newer |
| Phone | Pebble mobile app running the companion; internet access needed for fresh data |
| Building from source | Node.js 24.18.0, Bun, Pebble SDK 4.33.1, pebble-tool 5.0.40 |

## Getting started

1. Install [Lapin Futé from RePebble](https://apps.repebble.com/6d6aa01b7ecb4cfea469a183).
2. In the Pebble mobile app, open Lapin Futé's settings. Under PRIM access, paste a personal access token generated on the [PRIM portal](https://prim.iledefrance-mobilites.fr/fr/mes-jetons-authentification).
3. Add up to six favorites by searching the bundled station catalog; searching and adding work without a token. Save, and your settings sync to the watch.
4. Open Lapin Futé on the watch. Departures refresh whenever the app opens, you change favorite, or you hold Select; the phone needs to be connected for fresh data.

Developers can also build and install the app locally using the instructions in [Build from source](#build-from-source).

## Watch controls

| Screen | Control | Action |
|---|---|---|
| Favorites | **Up / Down** | Move through favorites and the **Refresh all** row |
| Favorites | **Select** | Open the highlighted favorite |
| Favorites · Refresh all | **Select** | Refresh every favorite |
| Departures | **Up / Down** | Switch favorite |
| Departures | **Select** | Open the traffic view |
| Departures | **Hold Select** | Force a refresh |
| Traffic | **Up / Down** | Page through messages |
| Any screen | **Back** | Return to the previous screen |

Countdowns and the clock keep updating on the watch every minute; only the actions above trigger network requests.

## Privacy

Your PRIM token stays on your phone. It is stored locally and sent only as the request header of the companion's direct HTTPS calls to PRIM, which is operated by Île-de-France Mobilités. It never reaches the watch, your favorites, cached data, URLs, or logs. Browsing the settings page and its station catalog sends no credentials. The app has no telemetry, no analytics, and no background or periodic network activity.

## Build from source

Install the pinned prerequisites from the table above; no repository script installs a toolchain for you.

```sh
npm test
npm run build
```

`npm run build` runs the test suite, generates the bilingual display copy, bundles the watchapp for emery and gabbro, and verifies the result. The watch build needs no catalog and no network. Its one optional input is the settings-page URL:

```sh
LAPIN_FUTE_CONFIG_URL=https://example.org/lapin-fute/ npm run build
```

The station catalog is generated ahead of time from open IDFM datasets. With `IDFM_DATASET_TOKEN` in `.env`:

```sh
node --env-file=.env scripts/refresh-catalog.mjs   # download, build, and publish the catalog
npm run build:config-site                          # assemble var/config-site; fails without a published catalog
```

`node --env-file=.env scripts/probe-catalog.mjs` runs a small live check against PRIM, one request per transport mode, and needs a `PRIM_API_KEY`. Operator tokens live only in `.env` and are never printed or embedded in build output.

## Store publishing

Pushing a stable version tag (`v1.2.3`) publishes the GitHub release first; once it succeeds, `scripts/publish-pebble-store.mjs` uploads the exact validated PBW to the RePebble store. Preview tags (`pre-v`) and manual dispatches never reach the store job, which runs in the `pebble-store` environment with read-only repository access.

One-time setup in the repository settings:

- **Create the `pebble-store` environment with real protections.** Add required reviewers and a tag rule limited to `v*` under Settings, Environments. Referencing the environment in the workflow alone protects nothing; the reviewers and the tag rule are what gate a release.
- **Add `PEBBLE_FIREBASE_REFRESH_TOKEN` as an environment secret.** Run `pebble login` yourself and take the refresh token from the tool's local credential file (`firebase_oauth_storage.json` in the pebble-tool configuration directory). Never paste credentials into issues, pull requests, or chats.
- **Plan for rotation.** A refresh token can be revoked or rotated, and a rotated token returned during a run never updates the GitHub secret. If a run fails authentication, run `pebble login` again and update the secret.

An approved run performs one authenticated upload of the already checksum-verified archive bytes. Nothing is rebuilt, screenshots are left unchanged, and publication is immediate. The job refuses versions that are not newer than the published version on either platform, but hidden drafts are invisible to that preflight; before rerunning an uncertain upload, inspect the developer dashboard, since the job offers no overwrite guarantee there.

## Icon

The icon is a rounded red ticket (`#fa4a36`) whose cut-out route traces the rabbit down to two round stops. All files live under `packages/config-page/assets/`:

| File | Format | Background |
|---|---|---|
| [`lapin-fute.svg`](packages/config-page/assets/lapin-fute.svg) | Vector source | Transparent |
| [`lapin-fute-1024.png`](packages/config-page/assets/lapin-fute-1024.png) | PNG, 1024 × 1024 | Transparent |
| [`lapin-fute-1024.jpg`](packages/config-page/assets/lapin-fute-1024.jpg) | JPEG, 1024 × 1024 | White |

## Contributing

Bug reports are welcome on the [issue tracker](https://github.com/Anthodev/lapin-fute/issues). A useful report includes the watch model and firmware, the phone setup, the steps to reproduce, and whether the data shown was live or cached. Never paste your PRIM token or other personal data in an issue.

Code changes should keep the frozen message contracts and the phone-only credential boundary intact.

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
  <a href="#features">Features</a>
  · <a href="#compatibility">Compatibility</a>
  · <a href="#getting-started">Getting started</a>
  · <a href="#watch-controls">Watch controls</a>
  · <a href="#privacy">Privacy</a>
  · <a href="#build-from-source">Build from source</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Pebble-emery%20%7C%20gabbro-00A5E0" alt="Pebble emery and gabbro">
  <img src="https://img.shields.io/badge/Modes-M%C3%A9tro%C2%B7RER%C2%B7Transilien%C2%B7Tram%C2%B7Bus-00A5E0" alt="Métro, RER, Transilien, Tram and Bus">
  <img src="https://img.shields.io/badge/Language-EN%20%7C%20FR-00A5E0" alt="English and French">
  <img src="https://img.shields.io/badge/status-pre--release-F59E0B" alt="Pre-release status">
</p>

> [!IMPORTANT]
> Lapin Futé is experimental and not published yet. Trying it currently requires building the watchapp and hosting its settings page. Live departures require a personal [PRIM](https://prim.iledefrance-mobilites.fr/fr/mes-jetons-authentification) access token. Emulator checks do not replace physical-watch validation, which remains pending. The project is not affiliated with RATP or Île-de-France Mobilités.

## About

Lapin Futé puts Île-de-France public-transport departures on a Pebble watch. The watch shows a list of favorites with the next departures, a departure board per favorite, and the current service messages for its line. A companion on your phone fetches the data from PRIM, Île-de-France Mobilités' open-data platform, and prepares everything the watch displays; the watch itself never goes online.

The name nods to Bison Futé, the French road-traffic information service, and to Serge, the rabbit from RATP's safety campaigns. On the icon, the rabbit's outline traces an itinerary that ends at two round stops.

## Features

- **Six favorites, five transport modes.** Choose any stop, line, and direction across Métro, RER, Transilien, Tram, and Bus. Favorites are renamed and reordered on the phone page, which shows official line badges and colors.
- **Departures at a glance.** The favorites list already shows the next departures for each stop; Select opens a full board for one favorite. Countdowns keep ticking on the watch between refreshes.
- **Traffic view.** Select again on a departure board to page through the current service messages for that line.
- **Refresh when needed.** Open the app, switch favorite, choose Refresh all, or hold Select to request departures. Recent results are reused for 60 seconds; there is no periodic network polling.
- **Clear data states.** The app distinguishes real-time departures, mixed real-time and scheduled results, updates in progress, and missing cached data.
- **English and French.** The watch interface and the settings page are both bilingual.
- **Settings that fit your phone.** Light and dark themes follow your system preference. Collapsible sections keep favorite editing, PRIM access, and watch synchronization easy to reach.

## Compatibility

| Requirement | Details |
|---|---|
| Watches | Pebble Time 2 (emery profile, primary target); the gabbro round profile is experimental |
| Firmware | 4.32 or newer |
| Phone | Pebble mobile app running the companion; internet access needed for fresh data |
| Building from source | Node.js 24.18.0, Bun, Pebble SDK 4.33.1, pebble-tool 5.0.40 |

## Getting started

There is no published package yet, so first use means one build and one static host:

1. Build the watchapp from source (see [Build from source](#build-from-source)); the built package is written under `packages/watch/build/`.
2. Generate the station catalog and build the settings page using the commands below. `npm run build:config-site` assembles the site in `var/config-site`. Publish that folder on a static HTTPS host, then build the watchapp with `LAPIN_FUTE_CONFIG_URL=https://your-host/` so the phone opens your settings page.
3. Install the built package on your watch with the Pebble tooling, or try it first in the emery or gabbro emulator.
4. In the Pebble mobile app, open Lapin Futé's settings. Under PRIM access, paste a personal access token generated on the [PRIM portal](https://prim.iledefrance-mobilites.fr/fr/mes-jetons-authentification).
5. Add up to six favorites by searching the bundled station catalog; searching and adding work without a token. Save, and your settings sync to the watch.
6. Open Lapin Futé on the watch. Departures refresh whenever the app opens, you change favorite, or you hold Select; the phone needs to be connected for fresh data.

## Watch controls

| Screen | Buttons |
|---|---|
| Favorites list | Up/Down move through favorites and the Refresh all row; Select opens the highlighted favorite, or refreshes everything from the Refresh all row |
| Departures | Up/Down switch favorite; Select opens the traffic view; holding Select forces a refresh |
| Traffic | Up/Down page through messages |
| Anywhere | Back steps back to the previous screen |

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

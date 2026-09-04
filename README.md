<h1 align="center">Lapin Futé</h1>

<p align="center">
  <strong>Île-de-France departures on Pebble, without background traffic.</strong>
  <br>
  One Alloy watchapp, one phone companion, and a narrow PRIM credential boundary.
</p>

<p align="center">
  <a href="#about">About</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="#build-from-source">Build</a>
  ·
  <a href="#quality-gates">Quality gates</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Pebble-emery%20%7C%20gabbro-00A5E0" alt="Pebble emery and gabbro">
  <img src="https://img.shields.io/badge/Alloy-embedded%20JavaScript-20232A" alt="Alloy embedded JavaScript">
  <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/status-pre--release-F59E0B" alt="Pre-release status">
</p>

## About

Lapin Futé shows IDFM/PRIM departures on a Pebble watch. The watch runs one [Alloy](https://developer.repebble.com/guides/js-apps/) embedded-JavaScript application with a Piu interface. It targets `emery` and `gabbro`; there is no native watchapp fallback.

```text
Departure and traffic views
          │ symbolic AppMessage aliases
          ▼
PebbleKit JS companion ── 60 s cache ──► HTTPS PRIM
          │
          └── phone-local favorites (six) + personal key
```

**The watch never receives the personal PRIM key and never starts network or background requests.**

## Highlights

- **One watch runtime.** Alloy/XS owns the receiver state machine, committed configuration storage, and the Piu interface that renders prepared favorite, departure, and traffic records. The embedded sources `main`, `runtime`, `packed`, `storage`, and `ui` bundle with the generated copy into the single module the manifest declares. The only C file is the standard `mdbl.c` VM bootstrap.
- **Frozen wire IDs.** Runtime code uses `SCHEMA_VERSION`, `REQUEST_ID`, and the other symbolic aliases. `packages/watch/package.json` and `packages/contracts/src/index.ts` map exactly 19 aliases to the frozen IDs `0, 1, 2, 3, 10, 11, 12, 24, 35..45`, and the retired v1 IDs are never reused. Display dictionaries carry `DISPLAY_WIRE_VERSION` 2 while domain data stays at schema version 1; the SDK transport key 15025 remains outside the D2 key table.
- **Atomic updates.** Configuration and result sequences stay private until their matching commit. A malformed, late, incomplete, or mismatched warm sequence cannot replace the last complete state. FULL is the deliberate exception: once the watch confirms the complete inventory and crosses the guarded durable seam, its previous configuration is already cleared, so a failed FULL leaves the watch unconfigured instead of restoring old metadata.
- **Event-only requests.** The watch never polls the network or schedules periodic requests. The phone fetches only when the app opens, the Refresh all row is used, a detail-view favorite change settles for 500 ms, or long Select explicitly refreshes the active favorite, each stale request gated by the 60-second cache. Trigger 5 is strictly cache-only: its overview and detail answers come from the phone cache with no network request and no refreshing echo, and a missing entry reports no cached data instead of fetching. A changed-favorite DIFF that passes the complete hash inventory with a nonzero need mask clears the watch's results and shows the loading state before any body transfers; after the commit the watch re-acquires its results from the cache only. The FULL mode is the explicit destructive resync.
- **Phone-prepared layout.** The phone runtime measures, wraps, clips, and packs each appearance and traffic record against pinned firmware font metrics, and the watch verifies the appearance hash before admitting it. The fixed bilingual copy corpus is generated at build time, and the watch assembles countdown and clock values locally, so it renders prepared text without any text fitting. Two display profiles exist, emery at 200×228 rectangular and gabbro at 260×260 round, chosen once at startup.
- **Phone-owned data access.** PebbleKit JS retains ACK-serialized sending, the 60-second cache, direct PRIM requests, configuration storage, the active-watch language, and the whole display seam: font metrics, bilingual copy corpus, record preparation, and the UTF-8 forward and reverse hash. The exact personal-key boundary is unchanged.

## Architecture

| Component | Owns | Must not |
|---|---|---|
| Static catalog | Offline-generated IDFM import, validated SQLite candidate, published JSON (manifest, search buckets, services, place pages) beside the config page | contain credentials or proxy live PRIM traffic |
| Configuration page | Statically hosted favorite editing with the six-favorite cap, masked key replacement/removal, static catalog place/service lookup | receive the stored key when reopening |
| PebbleKit JS | One atomic phone-local record, direct PRIM HTTPS requests, cache, watch synchronization, display preparation and packing, active-watch language | expose the key over AppMessage |
| Alloy watchapp | Prepared-record rendering with local navigation, committed configuration storage, loading and error states, data requests to the phone | PRIM networking or credentials; WakeUp, Worker, timeline, touch polling, text fitting, or secret storage |

The embedded sources are `main`, `runtime`, `packed`, `storage`, and `ui` under `packages/watch/src/embeddedjs/`, plus the generated copy module `packages/watch/src/generated/display-copy.js`; Bun bundles them into the one module the manifest declares.

## Targets and requirements

| Layer | Pinned requirement |
|---|---|
| Watch targets | `emery` primary and physical Pebble Time 2; `gabbro` emulator |
| Firmware | 4.32 or newer |
| Pebble SDK | 4.33.1 |
| Pebble CLI | `pebble-tool` 5.0.40 |
| Host runtime | Node.js 24.18.0 |
| Watch UI | Piu, four pinned built-in font roles (regular14, bold14, bold18, bold36), `touchCount=0`, no media |


## Build from source

Install the pinned prerequisites from the table above. No repository script installs or upgrades a toolchain.

```sh
npm test
npm run measure:radio
npm run build
```

`npm run build` runs the host suite, which generates the display copy first, then measures the modeled D2 radio exchanges, bundles the watch sources with Bun into one generated module, generates the PebbleKit JS tree, builds the single Alloy package, and verifies the generated alias-to-ID map. The watch build needs no catalog and no network. The one optional build input is the credential-free HTTPS URL of the statically hosted configuration page:

```sh
LAPIN_FUTE_CONFIG_URL=https://example.org/config/ \
npm run build
```

Personal PRIM keys are never build inputs.

The catalog toolchain (`packages/catalog`) is offline except for its operator-driven refresh. With `IDFM_DATASET_TOKEN` in `.env`, `node --env-file=.env scripts/refresh-catalog.mjs` downloads the IDFM sources, builds and validates the SQLite catalog, and publishes the static JSON catalog to `var/catalog/static`. `npm run build:config-site` then assembles the deployable site in `var/config-site`: the config page with the published catalog under `catalog/` beside `index.html`. It fails explicitly when no real catalog was published; there is no fixture fallback. `npm run catalog:probe` performs the operator-run live PRIM probe using `PRIM_API_KEY`. Operator tokens live only in `.env` and are never printed, exported, or copied into build output.

## Privacy

The personal key follows one path: masked configuration control, changed-value close fragment, phone-local `localStorage`, then the exact PRIM `apikey` header on the companion's direct HTTPS request. Static catalog and configuration-page requests carry no credential. It does not enter watch messages, favorites, results, caches, URLs, logs, metrics, traces, errors, or public evidence.

Lapin Futé has no telemetry. The watch has no network module and starts no periodic or background request.

## Quality gates

| Gate | Budget |
|---|---|
| Native VM memory | Fixed 57,344-byte split: stack 3,584, slots 41,472, chunks 12,288 |
| Phone-to-watch dictionary | At most 768 encoded bytes |
| Watch-to-phone dictionary | At most 192 encoded bytes |
| Watch unsent queue | Four messages, at most once, one write per `onWritable` |
| Full six-favorite configuration | 15 dictionaries, modeled host bound |
| Initial D2 startup | 18 D2 dictionary attempts, modeled host bound, excluding the SDK transport; one conditional SDK announcement/echo pair adds 2 |
| SDK transport key | 15025 belongs to the SDK transport, never to a D2 message |

Validation status: host suites, the modeled radio gate, and release builds for both targets pass. The current production PBW has run on the Emery and Gabbro emulators against recorded fixtures with zero live PRIM calls: startup, six-favorite synchronization, detail and traffic views, unchanged and reordered DIFFs, a changed-favorite DIFF with its loading state and cache-only recovery, and FULL resync with manual recovery all executed.

Retained reopen and ten minutes of inactivity pass on both emulators; the idle windows emitted no AppMessages or additional fixture requests. With the fixed VM split, the bounded six-favorite corpus left at least 10% of the chunk arena free at measured natural compacted-live samples on both targets. These samples do not certify every transient or lifetime memory peak. Physical-device validation and the 24-hour battery gate remain open. This is not a release.

## Contributing

Keep the frozen contracts, symbolic runtime payloads, event-only policy, and secret boundary intact: domain data stays at schema version 1, display dictionaries at wire version 2, and `packages/watch/package.json` pins the alias-to-ID map next to the canonical contract in `packages/contracts/src/index.ts`. Changes to message IDs, targets, toolchain pins, budgets, or ownership boundaries need matching contract tests.

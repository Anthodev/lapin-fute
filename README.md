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
  <img src="https://img.shields.io/badge/status-foundation-F59E0B" alt="Foundation status">
</p>

> [!IMPORTANT]
> Lapin Futé is a foundation implementation for [issue #2](https://github.com/Anthodev/lapin-fute/issues/2). Host-side contracts and the recorded fixture are present. Emulator, Pebble Time 2, XS-memory, and battery evidence remain external release gates because the Pebble CLI is not installed on the current development host.

## About

Lapin Futé shows IDFM/PRIM departures on a Pebble watch. The watch runs one [Alloy](https://developer.repebble.com/guides/js-apps/) embedded-JavaScript application with a Piu interface. It targets `emery` and `gabbro`; there is no native watchapp fallback.

```text
Minimal Piu fixture view
          │ symbolic AppMessage aliases
          ▼
PebbleKit JS companion ── 60 s public cache ──► HTTPS backend ──► PRIM
          │
          └── phone-local favorites + personal key
```

**The watch never receives the personal PRIM key and never starts network or background work.**

## Highlights

- **One watch runtime.** Alloy/XS owns protocol staging, localization, and the minimal recorded-fixture renderer. The only C file is the standard `mdbl.c` VM bootstrap.
- **Frozen wire IDs.** Runtime code uses `SCHEMA_VERSION`, `REQUEST_ID`, and the other symbolic aliases. `packages/watch/package.json` explicitly maps those aliases to the frozen IDs `0..24`.
- **Atomic updates.** Configuration and result sequences stay private until their matching commit. A malformed, late, incomplete, or mismatched sequence cannot replace the last complete state.
- **Foundation round trip.** The watch sends one `APP_OPEN` fixture request after its first complete configuration. The companion returns the recorded result without XHR.
- **Responsive fixture layout.** Geometry comes from screen dimensions and roundness. Emery shows up to three recorded departure rows; Gabbro shows up to two.
- **Phone-owned data access.** PebbleKit JS retains ACK-serialized sending, the 60-second cache, configuration storage, and the exact personal-key boundary.

## Architecture

| Component | Owns | Must not |
|---|---|---|
| Backend | Exact-host PRIM relay, response validation, normalization, non-secret shared cache | persist credentials or user preferences |
| Configuration page | Favorite editing and masked key replacement/removal | receive the stored key when reopening |
| PebbleKit JS | One atomic phone-local record, HTTPS requests, cache, watch synchronization, active-watch language | parse watch layout or expose the key over AppMessage |
| Alloy watchapp | Fixture request, protocol staging, minimal bilingual Piu rendering | implement favorite browsing or production consultation behavior; use networking, WakeUp, Worker, timeline, touch polling, or secret storage |

The embedded modules are `main`, `controller`, `model`, `protocol`, `message-queue`, `localization`, `ui`, and `contracts`. Every module appears in `packages/watch/src/embeddedjs/manifest.json`.

## Targets and requirements

| Layer | Pinned requirement |
|---|---|
| Watch targets | `emery` primary and physical Pebble Time 2; `gabbro` emulator |
| Firmware | 4.32 or newer |
| Pebble SDK | 4.33.1 |
| Pebble CLI | `pebble-tool` 5.0.40 |
| Host runtime | Node.js 24.18.0 |
| Watch UI | Piu, built-in Pebble fonts, `touchCount=0`, no media |

See [platforms](docs/platforms.md) and [toolchain](docs/toolchain.md) for the exact proof matrix and commands.


## Build from source

Install the pinned prerequisites in [docs/toolchain.md](docs/toolchain.md). No repository script installs or upgrades a toolchain.

```sh
npm test
npm run measure:radio
npm run build
```

`npm run build` runs the host contracts, measures the recorded radio fixture, generates the PebbleKit JS tree, builds the single Alloy package, then verifies the generated alias-to-ID map. Optional hosted endpoints are explicit, credential-free HTTPS build inputs:

```sh
LAPIN_FUTE_CONFIG_URL=https://example.org/config/ \
LAPIN_FUTE_BACKEND_URL=https://example.org/api/departures \
npm run build
```

Personal PRIM keys are never build inputs.

## Privacy

The personal key follows one path: masked configuration control, changed-value close fragment, phone-local `localStorage`, HTTPS `Authorization`, transient backend memory, then the exact PRIM `apikey` header. It does not enter watch messages, favorites, results, caches, URLs, logs, metrics, traces, errors, or public evidence.

Lapin Futé has no telemetry. The watch has no network module and starts no periodic or background request.

## Quality gates

| Gate | Budget |
|---|---|
| Alloy app binary | At most 120 KiB on each target |
| Loaded image and RAM | At most 56 KiB each |
| XS arenas | At least 25% free at the worst measured point |
| Settled XS drift | At most 1 KiB over the final ten of 50 cycles |
| Two-departure refresh | At most 7 dictionaries and 2048 encoded bytes |
| Watch request | At most 192 encoded bytes |
| Phone-to-watch dictionary | At most 768 encoded bytes |
| Watch unsent queue | Four messages, at most once, one write per `onWritable` |

The physical 24-hour A/B battery gate remains unchanged. See [performance](docs/performance.md) and the truthful [evidence ledger](docs/evidence.md).

## Documentation

- [Contracts](docs/contracts.md)
- [Toolchain](docs/toolchain.md)
- [Platforms](docs/platforms.md)
- [Performance and battery](docs/performance.md)
- [Localization](docs/localization.md)
- [Evidence ledger](docs/evidence.md)

## Contributing

Keep the frozen v1 contracts, symbolic runtime payloads, event-only policy, and secret boundary intact. Changes to message IDs, targets, toolchain pins, budgets, or ownership boundaries need matching contract tests and evidence-ledger updates.

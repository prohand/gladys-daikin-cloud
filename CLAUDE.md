# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **external Gladys Assistant integration** (a container the Gladys supervisor runs, not code inside Gladys) that drives Daikin air conditioners through the public [Onecta cloud API](https://developer.cloud.daikineurope.com/). ESM-only, Node >= 20, one runtime dependency: `@gladysassistant/integration-sdk`.

## Commands

```bash
npm install
npm test                              # node --test test/*.test.js (built-in runner, no framework)
node --test test/mapping.test.js      # one file
node --test --test-name-pattern 'louver' test/mapping.test.js   # one test
npm run lint                          # eslint .
npm run format                        # prettier --write .
npm run format:check                  # what CI gates on
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `test` on Node 24 — the version the Docker image ships. All three must pass.

Running against a real Gladys needs the three variables the supervisor injects; the SDK reads them itself:

```bash
GLADYS_HOST_API_URL=http://localhost:1443 \
GLADYS_INTEGRATION_TOKEN=<integration jwt> \
GLADYS_INTEGRATION_SELECTOR=<selector> \
npm start
```

Releases are cut from the GitHub UI (Actions → Release) or by pushing a `vX.Y.Z` tag — never bump `package.json` or the manifest by hand, `release.yml` writes both (including the `docker_image` tag and the `cover_image` ref) and re-runs Prettier over the manifest.

## Architecture

```
index.js                    SDK wiring only: handlers registered BEFORE connect()
src/config.js               config_schema values + OAuth tokens stored off-schema
src/capabilities.js         which feature catalog this Gladys accepts
src/store.js                the account snapshot and the refresh schedule
src/daikin/oauth.js         authorize URL, code exchange, refresh
src/daikin/api.js           REST client, token lifecycle, rate-limit headers
src/daikin/model.js         raw gateway-devices payload -> normalized units
src/mapping.js              Daikin strings <-> Gladys numeric enums (pure)
src/devices/climateUnit.js  one unit -> discovery payload / states / commands
src/devices/index.js        catalog, transport badges, device->unit routing
```

Data flows one way: `api` → `model.parseUnits()` → the store's `units` snapshot → `devices/` builds discovery/state/command payloads → SDK. `index.js` holds no protocol logic, `src/mapping.js` and `src/devices/climateUnit.js` are pure and never touch the network.

### Invariants worth knowing before changing anything

**The API quota governs everything.** A developer account gets 200 calls/day, 20/minute. `GET /v1/gateway-devices` returns the entire account in one call, so the integration publishes **no `poll_frequency`** on its devices (Gladys would poll each device, once a minute at the slowest) and runs its own timer in `src/store.js` — default 900 s, clamped to 600–21600 in `src/config.js` and mirrored in the manifest. Concurrent refreshes collapse into the one in flight. Never add a per-device read.

That timer is the only thing keeping Gladys up to date, and on a first install it cannot be armed from the `connected` handler: no account is linked yet, so that handler returns early. Every path that can leave the integration able to read the cloud (`onOAuthCallback`, `onConfigUpdated`, `test_connection`) calls `startPolling()`, which is a no-op when the account is not linked and, through `store.ensurePolling()`, restarts the timer only when the interval actually changed — calling it again must never push the next read further away.

**Writes are optimistic.** The cloud serves stale values for a few seconds after a `PATCH`, so `onSetValue` sends the writes, calls `store.markCommandSent()` (opening a 10 s quiet period before the next read) and `store.applyWrites()` to patch the snapshot, then publishes the new state itself. Any new command must extend `applyWrites` in `src/store.js` alongside `buildCommands` in `climateUnit.js`, or the dashboard shows the old value until the next poll.

**The feature catalog is found by trying, not by version-sniffing.** Publishing a feature type an older core does not know fails the _whole_ discovery payload. `publishWithBestCatalog()` publishes the richest catalog (`full` → `fan` → `energy` → `base`) and steps down until Gladys accepts one; the accepted `capabilities` object then drives which states are published, so discovery and states must always be built from the same capabilities. The one exception is `supported_options`, validated at device _creation_ where no retry can catch it — it stays gated on a Gladys version check (4.84.3+) and is left off when the version cannot be read. Do not reintroduce version-derived catalogs.

**Catalog = union over operation modes, state = active mode.** Daikin describes fan speed and louvers per operation mode, and the modes differ (no manual level in `dry`, no louvers in several). `parseFanControl` computes a union for the feature list and keeps `current` for reads and writes, so controls stop appearing and disappearing depending on what the unit was doing at discovery time. `applyWrites` also follows `fan.current` into the new mode on a mode change.

**Only what maps cleanly gets published.** Daikin's airflow _mode_ (`auto`/`quiet`/`fixed`) is deliberately dropped — `fan.mode` offers five fixed labels the UI cannot restrict. Setting a level writes `fanSpeed/currentMode = fixed` first, then the level. Louvers get one air conditioning feature per axis (`swing-horizontal`/`swing-vertical`); on a Gladys without the per-axis type they fold into a single `fan.rock-setting` whose bitmap (bit 0 = left/right, bit 1 = up/down) carries both.

**The `switch`/`binary` slot belongs to the unit's power, and to nothing else.** Gladys' scene actions "turn on/off the switches" — like its assistants — resolve a device to the FIRST feature matching `(category: switch, type: binary)`, in whatever order the database returns the features; an `air-conditioning`/`binary` is invisible to them. The comfort toggles used to sit in that slot, so a scene asking to switch a unit off silently switched its Powerful mode off instead (confirmed in the logs: `onSetValue <- …:powerful = 0` → `PATCH powerfulMode = "off"`). The unit therefore publishes its on/off TWICE — `air-conditioning`/`binary` for the climate UI and HomeKit, `switch`/`binary` (`FEATURE.POWER_SWITCH`, no history, the twin already keeps it) for the scenes — and the comfort toggles moved to `unknown`/`binary`, a pair Gladys renders as a plain on/off control. Because a command can now move more than the feature it was addressed to, `buildCommands` returns a LIST of states, not one. Never publish a second `switch`/`binary` on these devices.

**Gladys stores every feature state as a number**, so `src/mapping.js` mirrors the core enums (`AC_MODE`, `AC_SWING`, `FAN_ROCK_SETTING`) by hand — the SDK does not export them. Same for the FAN category/type literals in `climateUnit.js`.

**Feature-type gotcha:** `min`/`max` are NOT NULL in the Gladys schema for _every_ feature, binary ones included; omitting them fails device creation.

**Identity:** a Gladys device is one `climateControl` management point, keyed `${deviceId}_${embeddedId}` (a gateway can expose several). External ids come from `gladys.externalIds(DEVICE_TYPE, platformId)`; `featureKeyOf()` recovers the feature key by stripping the device prefix. Publishing discovered devices is an idempotent upsert by `external_id` — that is how renames and new units propagate.

**`onDeviceCreated`/`onDeviceUpdated` must republish.** Gladys silently drops states for a device that does not exist yet, so a freshly created device would sit on "no recent value" until the next scheduled refresh. Both handlers replay from the in-memory snapshot (no API call).

**Not everything lives on `climateControl`.** `dryKeepSetting` belongs to the `indoorUnit` point, so its write carries its own `embeddedId`. Toggles Daikin reports read-only are published as sensors rather than switches.

**Diagnostics over guessing.** `unusedCharacteristics()` in `index.js` (against `USED_CHARACTERISTICS`) reports, per management point, what the unit declares and this code ignores. That is what lets the `test_connection` action distinguish "we don't map it" from "the public API does not expose it for your model" — `econoMode`, `streamerMode`, `dryKeepSetting` are commonly absent. The Configuration screen's connection-status message is also the live display of the remaining daily quota (`api.rateLimits`).

**The consumption counters are as fine as Daikin makes them.** `parseConsumption` reads `d` (24 two-hour slots, yesterday then today) and `m` (24 months, last year then this one) — so `today`, the sum of the day's slots, moves in steps of 0.1 kWh whatever the refresh interval (the in-progress slot rises as soon as another tenth of a kWh is used, it does not wait for the two hours to close), and `thisMonth`/`thisYear` are coarser still. `today` is therefore the only counter worth hanging Gladys' energy monitoring on: its midnight reset costs almost nothing (the first value of the new day is 0, and the core's `calculateConsumptionFromIndex` skips the negative step of a counter going back to zero), where the yearly one would deliver one lump a day. A running unit crosses 0.1 kWh every few tens of minutes, so the derived `thirty-minutes-consumption` fills nearly every window and the Day view charts a plausible curve; the quantization only shows at very low draw, as a few empty windows followed by one that catches up. Totals stay exact, and only ONE counter may carry that pair or the same energy is counted twice in the dashboard.

**The energy monitoring pair is linked by row id, so the payload names it.** Gladys derives nothing on its own: an integration publishes `thirty-minutes-consumption` + `thirty-minutes-consumption-cost` and chains them with `energy_parent_id` (cost → consumption → `ENERGY_TODAY`), then the core's 30-minute job fills them. `energy_parent_id` holds a feature UUID, not an external_id, so `buildDevice` has to know those ids before Gladys creates anything: `featureUuid()` derives them from the external_id (v5, stable across restarts — a random id would move the primary key of an existing feature and orphan its states), and `featureIdsByExternalId(await gladys.getDevices())` reuses the id Gladys already holds for a feature it created. A feature Gladys knows is published WITHOUT `id`; when that read fails (`knownFeatureIds` null) the pair is dropped for that publish rather than guessed. The index feature never carries `energy_parent_id`: parenting it to the house meter is the user's gesture in Settings → Energy, and `device.create` only touches the column when the key is present.

**Offline units are not published.** Stale values would draw flat lines that look like measurements; the transport badge (`cloud`, `cloud + degraded` on `isInErrorState`, `unreachable` on `isCloudConnectionUp: false`) carries the information instead.

**OAuth tokens live in the config store, outside `config_schema`** (`src/config.js`, `TOKEN_KEYS`): keys the schema does not declare are private storage and never reach the frontend. Every refresh is persisted immediately via `onTokensRefreshed` so a restart never costs another consent screen. `src/daikin/api.js` serializes all requests through a promise chain — parallel calls with an expired token would each refresh, and the second refresh invalidates the first.

## Manifest and tests

`gladys-assistant-integration.json` is the contract with the Gladys store: `config_schema` fields, the `test_connection` action, version, `docker_image` tag, `cover_image` URL and the catalog `categories`. That cover URL is pinned to the release tag, not to `main`: served from a stable address, a redrawn cover stayed invisible behind the store's, the docs site's and the browsers' caches. `categories` (`climate`) is the shelf the integration sits on in the catalog — 1 to 3 keys of the store's controlled vocabulary, and without them it is only reachable through "All" and search. Declaring the field forces `gladys_version` to start at 4.86.0 or later: an older core validates manifests against a strict field allowlist and rejects any unknown top-level field, so the store indexer refuses the pair. `test/manifest.test.js` enforces the manifest's consistency with the code (defaults, poll bounds, registered action handlers, version match with `package.json`, that version coupling) — when adding an action or a config field, update both sides or that test fails. `npx github:GladysAssistant/integration-store .` runs the store's own admission checks locally, manifest schema and cover format included.

Tests stub `fetch` and use `test/helpers/fakeGladys.js` (an in-memory stand-in for the SDK surface) plus realistic payloads in `test/fixtures/gatewayDevices.js` (split unit, heat pump, offline unit). No network in the suite. New Daikin payload shapes belong in the fixtures.

## Conventions

Prettier (100 cols, single quotes, trailing commas) owns formatting; ESLint only catches real mistakes and treats `_`-prefixed identifiers as intentionally unused. Files open with a `// ---` header block explaining _why_ the module exists, and exported functions carry JSDoc — match that. Comments here explain decisions and dead ends, not mechanics; keep that register when editing. User-facing strings (errors surfaced in the UI, status messages, action results) are `{ en, fr }` pairs.

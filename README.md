# Gladys — Daikin Cloud

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls **Daikin air conditioners** through the official
[Daikin Onecta cloud API](https://developer.cloud.daikineurope.com/), built on
the [JavaScript integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
and started from the
[official integration template](https://github.com/GladysAssistant/integration-template-js).

![Cover](./cover.png)

> User documentation: [English](./docs/en.md) · [Français](./docs/fr.md)

Requires **Gladys 4.86 or later**: the manifest declares the store catalog
`categories` field, which older cores reject as an unknown field.

## Features

One Gladys device per Daikin climate unit, with only the features the hardware
actually reports:

- **On/Off**, published twice — as an air conditioning binary and as a switch,
  the only category the "turn off the switches" scene action can resolve
- **Mode** (auto, cooling, heating, drying, fan only)
- **Target temperature**, with the min/max/step of the active operation mode
- **Fan speed** level
- **Horizontal and vertical airflow**, per axis
- **Powerful**, **Econo**, **Streamer** and **Keep dry**, each published as an
  on/off control or, when Daikin reports it read-only, as a sensor
- **Room temperature** and **outdoor temperature** sensors, kept in history
- **Energy consumed** today, this month and this year, in kWh
- The **30-minute consumption and cost** of the Gladys energy monitoring, hung
  off the daily counter
- The remaining Daikin API quota, shown live in the Configuration screen
- A per-device transport badge: `cloud`, `cloud + degraded` when the unit
  reports a fault, `unreachable` when Daikin cannot reach it

The connection to the Daikin account uses the OAuth2 flow relayed by Gladys: the
tokens are exchanged and stored by the integration itself, and never transit
through the Gladys frontend.

### What the Onecta app shows and this integration cannot

The Onecta mobile app talks to Daikin's internal API. This integration talks to
the **public** Onecta API, through the `onecta:basic.integration` scope — and
that scope hands out a smaller payload. A function you use daily in the app can
therefore be simply absent from what the API returns, for your unit.

`econoMode`, `streamerMode` and `dryKeepSetting` are the usual ones. When they
are in the payload this integration publishes them as on/off controls; when they are
not, nothing can drive them — no integration built on the public API can, and
that is not a limitation of this code.

It depends on the model and the firmware, not on the function: those three do
appear for some units and not for others. Do not guess which case you are in —
run the **Test the connection** action. It reports the features published AND
the characteristics your unit declares that this integration ignores. A name
missing from **both** lists is one the API does not expose for your unit, and
there is nothing to be done about it.

## How it works

```
index.js                  SDK wiring: OAuth handlers, commands, lifecycle
src/config.js             config_schema values + off-schema token storage
src/capabilities.js       the catalog Gladys accepts, found by trying
src/store.js              the account snapshot and the refresh schedule
src/daikin/oauth.js       authorize URL, code exchange, token refresh
src/daikin/api.js         REST client, token lifecycle, rate-limit tracking
src/daikin/model.js       Daikin gateway devices -> normalized climate units
src/mapping.js            Daikin vocabulary <-> Gladys enums (pure functions)
src/devices/climateUnit.js  one unit -> discovery payload, states, commands
src/devices/index.js      the catalog: discovery, transports, routing
```

Five design points are worth knowing before touching the code.

**The polling is ours, not Gladys'.** A developer account is limited to 200 API
calls a day, and `poll_frequency` on a discovered device tops out at one minute
in Gladys. So the integration declares no `poll_frequency` and runs its own
schedule (`src/store.js`), reading every unit of the account in a single
`GET /v1/gateway-devices` and de-duplicating concurrent refreshes.

**Writes are applied optimistically.** The Daikin cloud serves the previous
values for a few seconds after a `PATCH`, so a command updates the local
snapshot and publishes the new state immediately; the store then waits out a
short quiet period before its next read.

**The feature catalog is found by trying, not by guessing.** Publishing a feature
— an older core does not know makes the WHOLE discovery payload fail. Deriving
the catalog from the Gladys version looked right and was not: the probe is a
single point of failure, and its failure silently stripped working features.
`src/capabilities.js` now publishes the richest catalog and steps down a level
at a time until Gladys accepts one, so a version that cannot be read costs
nothing. Only `supported_options` stays version-gated, because it is validated
at device creation, which no retry here can catch.

**The catalog comes from the union of every operation mode, the state from the
active one.** Daikin describes the fan per operation mode and the modes do not
offer the same things — no manual level in `dry`, no louvers in several of
them. Building the feature list from the active mode made the controls appear
and disappear depending on what the unit happened to be doing at discovery
time, so `parseFanControl` computes a union for the catalog and keeps
`current` for reading and writing.

**Only what maps cleanly gets published.** Daikin has an airflow mode
(`auto` / `quiet` / `fixed`) and, in `fixed`, a level on a model-dependent
scale. The level becomes `fan.speed`, a slider carrying the device's own bounds
so no scaling is needed. The airflow mode was dropped: `fan.mode` offers five
fixed labels the UI cannot restrict, so "Medium" had to stand for "manual" —
a control nobody could read. The louvers get one air conditioning feature per
axis, matching what Daikin drives and what the Onecta app shows; a core without
the per-axis type folds them into a single `fan.rock-setting` whose bitmap
encoding carries both — a step of the catalog ladder the manifest's 4.86
minimum now puts out of reach, kept because the ladder probes rather than
assumes.

## Development

```bash
npm install
npm test          # node --test, no test framework to install
npm run lint
npm run format
```

The tests cover the parts worth covering: the Daikin payload parsing against
realistic fixtures, the enum mapping both ways, the discovery payloads, the
command translation, the OAuth exchanges and the API client (token refresh,
401 retry, quota handling) — all with a stubbed `fetch`, no network.

### Running against a real Gladys

The integration expects the three environment variables the Gladys supervisor
injects into the container:

```bash
GLADYS_HOST_API_URL=http://localhost:1443 \
GLADYS_INTEGRATION_TOKEN=<integration jwt> \
GLADYS_INTEGRATION_SELECTOR=<selector> \
npm start
```

### Publishing an image

Push a `vX.Y.Z` tag, or run the **Release** workflow from the GitHub UI: it
bumps `package.json` and the manifest (version _and_ image tag), then builds and
pushes a multi-arch image (`linux/amd64` + `linux/arm64`) to `ghcr.io`.

The manifest declares `categories: ["climate"]` — the shelf the integration
sits on in the store catalog, out of the twelve keys of the store vocabulary
(1 to 3 per integration; without any, it only shows under "All" and in
search). The field requires `gladys_version` to start at 4.86.0 or later, and
the store validator enforces that coupling:

```bash
npx github:GladysAssistant/integration-store .
```

## License

Apache-2.0. Not affiliated with Daikin Europe N.V.

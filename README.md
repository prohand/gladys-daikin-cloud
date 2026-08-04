# Gladys — Daikin Cloud

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls **Daikin air conditioners** through the official
[Daikin Onecta cloud API](https://developer.cloud.daikineurope.com/), built on
the [JavaScript integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
and started from the
[official integration template](https://github.com/GladysAssistant/integration-template-js).

![Cover](./cover.png)

> User documentation: [English](./docs/en.md) · [Français](./docs/fr.md)

## Features

One Gladys device per Daikin climate unit, with only the features the hardware
actually reports:

- **On/Off**, **Mode** (auto, cooling, heating, drying, fan only)
- **Target temperature**, with the min/max/step of the active operation mode
- **Fan speed** (auto, quiet, fixed levels) and **horizontal / vertical swing**
- **Room temperature** and **outdoor temperature** sensors, kept in history
- A per-device transport badge: `cloud`, `cloud + degraded` when the unit
  reports a fault, `unreachable` when Daikin cannot reach it

The connection to the Daikin account uses the OAuth2 flow relayed by Gladys: the
tokens are exchanged and stored by the integration itself, and never transit
through the Gladys frontend.

## How it works

```
index.js                  SDK wiring: OAuth handlers, commands, lifecycle
src/config.js             config_schema values + off-schema token storage
src/capabilities.js       what the connected Gladys version can accept
src/store.js              the account snapshot and the refresh schedule
src/daikin/oauth.js       authorize URL, code exchange, token refresh
src/daikin/api.js         REST client, token lifecycle, rate-limit tracking
src/daikin/model.js       Daikin gateway devices -> normalized climate units
src/mapping.js            Daikin vocabulary <-> Gladys enums (pure functions)
src/devices/climateUnit.js  one unit -> discovery payload, states, commands
src/devices/index.js      the catalog: discovery, transports, routing
```

Three design points are worth knowing before touching the code.

**The polling is ours, not Gladys'.** A developer account is limited to 200 API
calls a day, and `poll_frequency` on a discovered device tops out at one minute
in Gladys. So the integration declares no `poll_frequency` and runs its own
schedule (`src/store.js`), reading every unit of the account in a single
`GET /v1/gateway-devices` and de-duplicating concurrent refreshes.

**Writes are applied optimistically.** The Daikin cloud serves the previous
values for a few seconds after a `PATCH`, so a command updates the local
snapshot and publishes the new state immediately; the store then waits out a
short quiet period before its next read.

**The feature catalog adapts to the Gladys version.** The air conditioning fan
speed and swing feature types landed in Gladys 4.84.3; publishing them to an
older core would make the whole discovery payload fail. `src/capabilities.js`
reads the connected version and the catalog is built from it, so an older Gladys
gets a working integration with fewer features rather than none.

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

## License

Apache-2.0. Not affiliated with Daikin Europe N.V.

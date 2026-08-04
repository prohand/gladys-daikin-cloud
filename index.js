// -----------------------------------------------------------------------------
// Entry point of the Daikin Cloud integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the Daikin cloud. It holds no protocol
// logic — the OAuth2 flow lives in src/daikin/oauth.js, the REST calls in
// src/daikin/api.js, the payload mapping in src/devices/ — it only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. keeps the Daikin session, the device list and the states in sync.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { hasCredentials, normalizeConfig, readTokens, tokensToConfig } from './src/config.js';
import { DEFAULT_CAPABILITIES, detectCapabilities } from './src/capabilities.js';
import { DaikinApi } from './src/daikin/api.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from './src/daikin/oauth.js';
import { DaikinStore } from './src/store.js';
import {
  buildAllStates,
  buildCommands,
  buildDiscoveredDevices,
  buildStates,
  buildTransportEntries,
  featureKeyOf,
  findUnitByDevice,
} from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();
// What the connected Gladys can accept (see src/capabilities.js).
let capabilities = { ...DEFAULT_CAPABILITIES };
// Anti-CSRF state of the OAuth2 flow in progress, generated when the user
// clicks "Connect" and verified when the provider redirects back.
let oauthState = null;

const api = new DaikinApi({
  // Every token renewal is persisted immediately: a container restart must
  // never cost the user another trip through the Daikin consent screen.
  onTokensRefreshed: async (tokens) => {
    await gladys.setConfig(tokensToConfig(tokens)).catch((err) => {
      logger.error('Could not persist the refreshed Daikin tokens', err);
    });
  },
});

const store = new DaikinStore({ api });

// --- OAuth2: the user clicks "Connect" on the Daikin account field -----------
gladys.onOAuthAuthorizeUrl((key, redirectUri) => {
  logger.info(`Building the Daikin authorization URL for "${key}"`);
  if (!hasCredentials(config)) {
    throw new Error('Fill in the client ID and the client secret first, then save.');
  }
  oauthState = randomUUID();
  return buildAuthorizeUrl({ clientId: config.client_id, redirectUri, state: oauthState });
});

// --- OAuth2: Daikin redirects back with the authorization code ---------------
gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
  logger.info(`Daikin redirected back for "${key}"`);
  if (!oauthState || state !== oauthState) {
    throw new Error('Unexpected OAuth state, restart the connection from Gladys.');
  }
  oauthState = null;

  const tokens = await exchangeCodeForTokens({
    clientId: config.client_id,
    clientSecret: config.client_secret,
    code,
    // The provider only accepts the code for the EXACT redirect URI the
    // authorization was requested with.
    redirectUri,
  });

  api.setCredentials({ clientId: config.client_id, clientSecret: config.client_secret });
  api.setTokens(tokens);
  await gladys.setConfig(tokensToConfig(tokens));

  // The account is linked: read it right away so the units show up in the
  // Discovery screen without waiting for the next scheduled refresh.
  await refreshAndPublish({ publishDevices: true });
  await gladys.setConnectionStatus(true);
});

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the Daikin account');
  await refreshAndPublish({ publishDevices: true });
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const unit = findUnitByDevice(gladys, store.units, device);
  if (!unit) {
    throw new Error(`Unknown Daikin unit for ${device.external_id}`);
  }
  const featureKey = featureKeyOf(gladys, unit, feature.external_id);
  if (!featureKey) {
    throw new Error(`Unknown feature ${feature.external_id}`);
  }
  if (!unit.online) {
    throw new Error(`${unit.name} is offline, Daikin cannot reach it right now`);
  }

  const { writes, state } = buildCommands(unit, featureKey, value);
  for (const write of writes) {
    await api.setCharacteristic({
      deviceId: unit.deviceId,
      embeddedId: unit.embeddedId,
      characteristic: write.characteristic,
      path: write.path,
      value: write.value,
    });
  }

  // The Daikin cloud serves the previous values for a few seconds after a
  // write: reflect the change locally and publish it now, the next scheduled
  // refresh will confirm it.
  store.markCommandSent();
  store.applyWrites(unit, writes);
  await gladys.publishState(feature.external_id, state);
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The devices carry no `poll_frequency` (see src/store.js: the Daikin quota
// makes a per-device poll impossible), so this only fires on an explicit
// refresh — and it is served from the shared, de-duplicated read.
gladys.onPoll(async (device) => {
  const units = await store.refresh();
  const unit = findUnitByDevice(gladys, units, device);
  if (!unit) {
    logger.warn(`onPoll: ${device.external_id} is no longer in the Daikin account`);
    return;
  }
  await gladys.publishStates(buildStates(gladys, unit, capabilities));
});

// --- Manifest action: the button in the Configuration screen ------------------
gladys.onAction('test_connection', async () => {
  logger.info('Action test_connection -> live request to the Daikin cloud');
  if (!hasCredentials(config)) {
    throw new Error('Fill in the client ID and the client secret first, then save.');
  }
  if (!api.isConnected) {
    throw new Error('No Daikin account linked yet: use the Connect button above.');
  }
  const units = await store.refresh();
  await publishEverything(units, { publishDevices: true });
  const remaining = api.rateLimits.remainingDay;
  return {
    en: `Connected: ${units.length} Daikin unit(s) found${remaining === null ? '' : `, ${remaining} API calls left today`}.`,
    fr: `Connecté : ${units.length} unité(s) Daikin trouvée(s)${remaining === null ? '' : `, ${remaining} appels API restants aujourd'hui`}.`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  const previous = config;
  config = normalizeConfig(newConfig);
  api.setCredentials({ clientId: config.client_id, clientSecret: config.client_secret });
  api.setTokens(readTokens(newConfig));

  if (config.poll_frequency !== previous.poll_frequency) {
    startPolling();
  }
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: these handlers only run
// the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // 1) What this Gladys accepts, then the config filled in by the user.
    capabilities = await detectCapabilities(gladys);
    const rawConfig = await gladys.getConfig();
    config = normalizeConfig(rawConfig);
    api.setCredentials({ clientId: config.client_id, clientSecret: config.client_secret });
    api.setTokens(readTokens(rawConfig));

    // 2) Nothing to read until the user linked their Daikin account: say so in
    // the Configuration screen instead of failing silently.
    if (!api.isConnected) {
      logger.info('No Daikin account linked yet, waiting for the OAuth2 connection');
      await gladys.setConnectionStatus(false, {
        en: 'No Daikin account linked yet: fill in your credentials and click Connect.',
        fr: 'Aucun compte Daikin lié : renseignez vos identifiants puis cliquez sur Connecter.',
      });
      return;
    }

    // 3) Read the account and publish everything we know about it.
    await refreshAndPublish({ publishDevices: true });
    await gladys.setConnectionStatus(true);

    // 4) Keep it fresh, on our own schedule.
    startPolling();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await reportFailure(err);
  }
});

gladys.on('disconnected', () => {
  store.stopPolling();
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  store.stopPolling();
});

/**
 * Read the Daikin account and push what changed to Gladys.
 * @param {{ publishDevices?: boolean }} [options] whether to re-publish the discovery payload
 * @returns {Promise<Array<object>>} the refreshed units
 */
async function refreshAndPublish({ publishDevices = false } = {}) {
  const units = await store.refresh();
  await publishEverything(units, { publishDevices });
  return units;
}

/**
 * Publish the devices (optional), their transport badges and their states.
 * @param {Array<object>} units the units of the account
 * @param {{ publishDevices?: boolean }} [options] whether to re-publish the discovery payload
 */
async function publishEverything(units, { publishDevices = false } = {}) {
  if (publishDevices) {
    // Idempotent (upsert by external_id): re-publishing is how a unit renamed
    // in the Onecta app, or a new unit added to the account, reaches Gladys.
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, units, capabilities));
  }
  if (units.length === 0) {
    return;
  }
  await gladys.publishTransports(buildTransportEntries(gladys, units));
  // Offline units report stale values: publishing them would draw flat lines
  // on the charts that look like real measurements.
  const onlineUnits = units.filter((unit) => unit.online);
  for (const batch of chunk(buildAllStates(gladys, onlineUnits, capabilities), 100)) {
    await gladys.publishStates(batch);
  }
}

/** (Re)start the scheduled refresh with the interval currently configured. */
function startPolling() {
  store.startPolling(config.poll_frequency, async (units) => {
    try {
      await publishEverything(units);
      await gladys.setConnectionStatus(true);
    } catch (err) {
      logger.error('Could not publish the refreshed states', err);
      await reportFailure(err);
    }
  });
}

/**
 * Surface a failure in the Configuration screen. A cloud integration can be
 * RUNNING and still unable to talk to its provider — without this channel the
 * user only sees an integration that quietly stopped updating.
 * @param {Error & { isAuthError?: boolean, isRateLimited?: boolean }} err what went wrong
 */
async function reportFailure(err) {
  let message = {
    en: 'Could not reach the Daikin cloud, check the integration logs.',
    fr: "Impossible de joindre le cloud Daikin, consultez les logs de l'intégration.",
  };
  if (err?.isAuthError) {
    message = {
      en: 'The Daikin session expired, please reconnect your account.',
      fr: 'La session Daikin a expiré, reconnectez votre compte.',
    };
  } else if (err?.isRateLimited) {
    message = {
      en: 'Daikin API quota reached, increase the refresh interval.',
      fr: "Quota de l'API Daikin atteint, augmentez l'intervalle de rafraîchissement.",
    };
  }
  await gladys.setConnectionStatus(false, message).catch(() => {});
}

/**
 * @param {Array<object>} items the list to split
 * @param {number} size the maximum size of a chunk
 * @returns {Array<Array<object>>} the chunks
 */
function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Daikin Cloud integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});

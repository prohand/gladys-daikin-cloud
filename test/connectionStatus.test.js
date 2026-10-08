import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStatus, failureMessage } from '../src/connectionStatus.js';
import { DaikinStore } from '../src/store.js';
import { DaikinApiError } from '../src/daikin/api.js';
import { SPLIT_UNIT } from './fixtures/gatewayDevices.js';

/**
 * The status reporter wired to a store the way index.js wires it, over a
 * Daikin client whose next read fails with `failure` (none: it works).
 * @returns {object} the store, the fake api, and the statuses Gladys received
 */
function setup() {
  const statuses = [];
  const gladys = {
    async setConnectionStatus(connected, message) {
      statuses.push({ connected, message });
    },
  };
  const api = {
    isConnected: true,
    rateLimits: { remainingDay: 120, limitDay: 200 },
    failure: null,
    async getGatewayDevices() {
      if (this.failure) {
        throw this.failure;
      }
      return [structuredClone(SPLIT_UNIT)];
    },
  };
  const status = new ConnectionStatus({ gladys, api });
  const store = new DaikinStore({
    api,
    onRead: () => status.readSucceeded(),
    onReadFailed: (err) => status.readFailed(err),
  });
  return { store, api, statuses };
}

test('a scheduled read refused by Daikin turns the status red, the next good one green', async () => {
  const { store, api, statuses } = setup();
  await store.refresh();
  assert.deepEqual(statuses, [], 'nothing to correct after a good read');

  // The refresh token was revoked from the Onecta app.
  api.failure = new DaikinApiError(401, 'Could not refresh the Daikin session');
  await assert.rejects(() => store.refresh());
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].connected, false);
  assert.match(statuses[0].message.en, /session expired/);

  api.failure = null;
  await store.refresh();
  await new Promise(setImmediate);
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1].connected, true);
  assert.match(statuses[1].message.en, /120\/200 Daikin API calls left/);

  await store.refresh();
  assert.equal(statuses.length, 2, 'no status update per read once it is right');
});

test('a spent quota is named as such', async () => {
  const { store, api, statuses } = setup();
  api.failure = new DaikinApiError(429, 'quota');
  await assert.rejects(() => store.refresh());
  assert.match(statuses[0].message.fr, /Quota/);
});

test('without a linked account a failed read keeps the "no account" message', async () => {
  const { store, api, statuses } = setup();
  api.isConnected = false;
  api.failure = new DaikinApiError(401, 'No Daikin account linked yet');
  await assert.rejects(() => store.refresh());
  assert.deepEqual(statuses, []);
});

test('every failure message is bilingual', () => {
  for (const err of [
    new DaikinApiError(401, 'x'),
    new DaikinApiError(429, 'x'),
    new Error('fetch failed'),
    undefined,
  ]) {
    const message = failureMessage(err);
    assert.ok(message.en && message.fr);
  }
});

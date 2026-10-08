import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWrites } from '../src/commands.js';
import { DaikinStore } from '../src/store.js';
import { SPLIT_UNIT } from './fixtures/gatewayDevices.js';

/**
 * A store holding the split unit (cooling, powerful off), and a Daikin client
 * that accepts the writes until the one numbered `failAt` (1-based).
 * @param {number} [failAt] the write Daikin refuses, none by default
 * @returns {Promise<{ store: DaikinStore, api: object, unit: object, sent: Array<object> }>} the fixture
 */
async function setup(failAt = Infinity) {
  const sent = [];
  const api = {
    async getGatewayDevices() {
      return [structuredClone(SPLIT_UNIT)];
    },
    async setCharacteristic(write) {
      if (sent.length + 1 >= failAt) {
        throw Object.assign(new Error('Daikin API error 502'), { status: 502 });
      }
      sent.push(write);
    },
  };
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();
  return { store, api, unit, sent };
}

const WRITES = [
  { characteristic: 'operationMode', value: 'heating' },
  { characteristic: 'powerfulMode', value: 'on' },
];

test('every accepted write lands in the snapshot', async () => {
  const { store, api, unit, sent } = await setup();
  await sendWrites({ api, store, unit, writes: WRITES });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].embeddedId, 'climateControl', 'the unit point by default');
  assert.equal(store.units[0].operationMode, 'heating');
  assert.equal(store.units[0].toggles.powerful.on, true);
  assert.ok(store.lastCommandAt > 0, 'the quiet period is open');
});

test('a failed second write keeps the first one, already applied by Daikin, in the snapshot', async () => {
  const { store, api, unit, sent } = await setup(2);
  await assert.rejects(() => sendWrites({ api, store, unit, writes: WRITES }), /502/);
  assert.equal(sent.length, 1);
  // The unit IS in heating now: describing it in cooling until the next read
  // would show the wrong mode, and send the next set_climate step to it.
  assert.equal(store.units[0].operationMode, 'heating');
  assert.equal(store.units[0].toggles.powerful.on, false, 'the refused write is not applied');
});

test('a failed first write leaves the snapshot alone', async () => {
  const { store, api, unit } = await setup(1);
  await assert.rejects(() => sendWrites({ api, store, unit, writes: WRITES }));
  assert.equal(store.units[0].operationMode, 'cooling');
  assert.ok(store.lastCommandAt > 0, 'a refused write still opens the quiet period');
});

test('the patch goes to the unit the snapshot holds when a read crossed the command', async () => {
  const { store, api, unit } = await setup();
  // A read answered while the command was in flight: the snapshot now holds
  // a new object for the same unit.
  await store.refresh();
  assert.notEqual(store.units[0], unit);
  await sendWrites({ api, store, unit, writes: WRITES });
  assert.equal(store.units[0].operationMode, 'heating');
});

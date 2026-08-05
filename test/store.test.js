import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaikinStore } from '../src/store.js';
import { AC_MODE } from '../src/mapping.js';
import { buildStates, FEATURE } from '../src/devices/index.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { ALL_DEVICES, SPLIT_UNIT } from './fixtures/gatewayDevices.js';

const gladys = createFakeGladys();
const CAPABILITIES = { fanCategory: true, supportedOptions: true, acSwing: true };

/**
 * @param {Array<object>} payload what the fake Daikin cloud answers
 * @returns {{ api: object, reads: { count: number } }} the fake API and its call counter
 */
function createFakeApi(payload = ALL_DEVICES) {
  const reads = { count: 0 };
  return {
    reads,
    api: {
      async getGatewayDevices() {
        reads.count += 1;
        // Deep copy: the store mutates its units, the fixtures must not drift.
        return structuredClone(payload);
      },
    },
  };
}

test('a refresh reads the whole account once and parses its units', async () => {
  const { api, reads } = createFakeApi();
  const store = new DaikinStore({ api });
  const units = await store.refresh();
  assert.equal(reads.count, 1);
  assert.equal(units.length, 3);
  assert.equal(store.units.length, 3);
  assert.ok(store.lastRefreshAt > 0);
});

test('concurrent refreshes share the single call in flight', async () => {
  const { api, reads } = createFakeApi();
  const store = new DaikinStore({ api });
  const [a, b, c] = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  assert.equal(reads.count, 1, 'the daily quota is 200 calls: never spend three for one refresh');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a refresh that failed does not block the next one', async () => {
  let calls = 0;
  const api = {
    async getGatewayDevices() {
      calls += 1;
      if (calls === 1) {
        throw new Error('boom');
      }
      return [SPLIT_UNIT];
    },
  };
  const store = new DaikinStore({ api });
  await assert.rejects(() => store.refresh());
  const units = await store.refresh();
  assert.equal(units.length, 1);
});

test('a unit is found back by its platform id', async () => {
  const { api } = createFakeApi();
  const store = new DaikinStore({ api });
  await store.refresh();
  assert.equal(store.getUnit(`${SPLIT_UNIT.id}_climateControl`).name, 'Living room');
  assert.equal(store.getUnit('nope'), undefined);
});

test('an accepted write is reflected locally, so the next read is already right', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();

  store.applyWrites(unit, [{ characteristic: 'onOffMode', value: 'off' }]);
  assert.equal(unit.power, 'off');

  store.applyWrites(unit, [
    {
      characteristic: 'temperatureControl',
      path: '/operationModes/cooling/setpoints/roomTemperature',
      value: 23.5,
    },
  ]);
  assert.equal(unit.setpoint.value, 23.5);
  assert.equal(unit.setpoints.cooling.value, 23.5, 'the per-mode setpoint is updated too');

  const states = buildStates(gladys, unit, CAPABILITIES);
  assert.equal(states.find((s) => s.device_feature_external_id.endsWith(FEATURE.POWER)).state, 0);
  assert.equal(
    states.find((s) => s.device_feature_external_id.endsWith(FEATURE.TARGET_TEMPERATURE)).state,
    23.5,
  );
});

test('changing the mode moves the active setpoint to the new mode', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();
  store.applyWrites(unit, [{ characteristic: 'operationMode', value: 'heating' }]);
  assert.equal(unit.operationMode, 'heating');
  assert.equal(unit.setpoint.value, 21, 'heating has its own setpoint on this unit');
  const states = buildStates(gladys, unit, CAPABILITIES);
  assert.equal(
    states.find((s) => s.device_feature_external_id.endsWith(FEATURE.MODE)).state,
    AC_MODE.HEATING,
  );
});

test('a fan write updates the mode and the level', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();
  store.applyWrites(unit, [
    {
      characteristic: 'fanControl',
      path: '/operationModes/cooling/fanSpeed/currentMode',
      value: 'fixed',
    },
    {
      characteristic: 'fanControl',
      path: '/operationModes/cooling/fanSpeed/modes/fixed',
      value: 5,
    },
  ]);
  const states = buildStates(gladys, unit, CAPABILITIES);
  assert.equal(
    states.find((s) => s.device_feature_external_id.endsWith(FEATURE.FAN_LEVEL)).state,
    5,
  );
});

test('a swing write updates the right axis', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();
  store.applyWrites(unit, [
    {
      characteristic: 'fanControl',
      path: '/operationModes/cooling/fanDirection/horizontal/currentMode',
      value: 'swing',
    },
  ]);
  assert.equal(unit.fan.current.direction.horizontal.value, 'swing');
  assert.equal(
    unit.fan.current.direction.vertical.value,
    'swing',
    'untouched, it was already swinging',
  );
});

test('a comfort toggle write is reflected locally', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();
  assert.equal(unit.toggles.powerful.on, false);
  store.applyWrites(unit, [{ characteristic: 'powerfulMode', value: 'on' }]);
  assert.equal(unit.toggles.powerful.on, true);
  const states = buildStates(gladys, unit, CAPABILITIES);
  assert.equal(
    states.find((s) => s.device_feature_external_id.endsWith(FEATURE.POWERFUL)).state,
    1,
  );
});

test('changing the operation mode moves the fan block with it', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const [unit] = await store.refresh();
  store.applyWrites(unit, [{ characteristic: 'operationMode', value: 'dry' }]);
  // `dry` runs on auto and has no louvers on this unit: the snapshot must
  // follow, otherwise the next read would describe the mode it just left.
  assert.equal(unit.fan.current.speed.currentMode, 'auto');
  assert.equal(unit.fan.current.direction, null);
});

test('a write on a unit without a fan is ignored instead of throwing', async () => {
  const { api } = createFakeApi(ALL_DEVICES);
  const store = new DaikinStore({ api });
  const units = await store.refresh();
  const heatPump = units.find((unit) => unit.name === 'Heat pump');
  store.applyWrites(heatPump, [
    {
      characteristic: 'fanControl',
      path: '/operationModes/heating/fanSpeed/currentMode',
      value: 'auto',
    },
  ]);
  assert.equal(heatPump.fan, null);
});

test('the scheduled refresh runs and can be stopped', async () => {
  const { api, reads } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const runs = [];
  store.startPolling(0.02, (units) => runs.push(units.length));
  await new Promise((resolve) => setTimeout(resolve, 70));
  store.stopPolling();
  const runsAfterStop = runs.length;
  assert.ok(runsAfterStop >= 1, 'the timer fired at least once');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs.length, runsAfterStop, 'stopPolling really stops it');
  assert.ok(reads.count >= 1);
});

test('ensurePolling arms the schedule once, and leaves the running timer alone', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  assert.equal(store.isPolling, false, 'nothing is scheduled before the account is linked');

  assert.equal(
    store.ensurePolling(900, () => {}),
    true,
    'the first call arms the timer',
  );
  assert.equal(store.isPolling, true);
  const timer = store.timer;

  assert.equal(
    store.ensurePolling(900, () => {}),
    false,
    'the second call is a no-op',
  );
  assert.equal(store.timer, timer, 'restarting would push the next read 15 minutes away again');

  assert.equal(
    store.ensurePolling(600, () => {}),
    true,
    'a new interval restarts the timer',
  );
  assert.equal(store.frequencySeconds, 600);
  store.stopPolling();
  assert.equal(store.isPolling, false);
  assert.equal(store.frequencySeconds, null);
});

test('ensurePolling really refreshes, exactly like startPolling', async () => {
  const { api, reads } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  const runs = [];
  store.ensurePolling(0.02, (units) => runs.push(units.length));
  await new Promise((resolve) => setTimeout(resolve, 70));
  store.stopPolling();
  assert.ok(runs.length >= 1, 'the timer fired at least once');
  assert.ok(reads.count >= 1);
});

test('a command opens a quiet period, because Daikin serves stale reads right after a write', async () => {
  const { api } = createFakeApi([SPLIT_UNIT]);
  const store = new DaikinStore({ api });
  store.markCommandSent();
  assert.ok(store.lastCommandAt > 0);
  // The wait itself is not exercised here (it would make the suite sleep 10 s);
  // what matters is that the timestamp is recorded for doRefresh() to honour.
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from '../src/daikin/model.js';
import { FEATURE, buildCommands } from '../src/devices/index.js';
import { AC_MODE } from '../src/mapping.js';
import { readFileSync } from 'node:fs';
import {
  MIN_FORCED_REFRESH_MS,
  SCENE_ACTION,
  accountOutputs,
  consumptionOutputs,
  forcedRefreshVerdict,
  refreshAccount,
  setClimate,
} from '../src/sceneActions.js';
import { DaikinStore } from '../src/store.js';
import {
  ALL_DEVICES,
  HEAT_PUMP_UNIT,
  OFFLINE_UNIT,
  SPLIT_UNIT,
} from './fixtures/gatewayDevices.js';

/**
 * The split unit, and a `sendCommand` that does what index.js does to the
 * snapshot (minus the network): build the writes, then apply them.
 * @param {object} [payload] the gateway device to parse
 * @returns {{ unit: object, sent: Array<Array<unknown>>, writes: Array<object>, sendCommand: Function }} the fixture
 */
function setup(payload = SPLIT_UNIT) {
  const [unit] = parseUnits([structuredClone(payload)]);
  const store = new DaikinStore({ api: {} });
  const sent = [];
  const writes = [];
  const sendCommand = async (featureKey, value) => {
    const command = buildCommands(unit, featureKey, value);
    sent.push([featureKey, value]);
    writes.push(...command.writes);
    store.applyWrites(unit, command.writes);
  };
  return { unit, sent, writes, sendCommand };
}

test('the mode lands before the setpoint, so the setpoint of the NEW mode is written', async () => {
  const { unit, sent, writes, sendCommand } = setup();
  unit.power = 'off';
  const outputs = await setClimate(
    unit,
    { power: 'on', mode: 'heating', temperature: 21.3 },
    sendCommand,
  );
  assert.deepEqual(sent, [
    [FEATURE.POWER, 1],
    [FEATURE.MODE, AC_MODE.HEATING],
    [FEATURE.TARGET_TEMPERATURE, 21.3],
  ]);
  assert.equal(writes[2].path, '/operationModes/heating/setpoints/roomTemperature');
  assert.equal(writes[2].value, 21.5, 'rounded to the step of the heating setpoint');
  assert.deepEqual(outputs, { power: 'on', mode: 'heating', temperature: 21.5, commands_sent: 3 });
});

test('what the unit already does costs no API call', async () => {
  const { unit, sent, sendCommand } = setup();
  // The fixture unit runs, in cooling, at 22 °C.
  const outputs = await setClimate(
    unit,
    { power: 'on', mode: 'cooling', temperature: 22 },
    sendCommand,
  );
  assert.deepEqual(sent, []);
  assert.equal(outputs.commands_sent, 0);
});

test('a fan level switches the fan to manual, in the mode being set', async () => {
  const { unit, writes, sendCommand } = setup();
  await setClimate(unit, { power: 'unchanged', mode: 'heating', fan_speed: 3 }, sendCommand);
  assert.deepEqual(
    writes.filter((write) => write.characteristic === 'fanControl').map((write) => write.path),
    [
      '/operationModes/heating/fanSpeed/currentMode',
      '/operationModes/heating/fanSpeed/modes/fixed',
    ],
  );
});

test('turning off sends only the power, whatever else the card says', async () => {
  const { unit, sent, sendCommand } = setup();
  const outputs = await setClimate(
    unit,
    { power: 'off', mode: 'heating', temperature: 25 },
    sendCommand,
  );
  assert.deepEqual(sent, [[FEATURE.POWER, 0]]);
  assert.equal(outputs.power, 'off');
  assert.equal(outputs.mode, 'cooling', 'the mode was left alone');
});

test('an impossible setting fails BEFORE the first write', async () => {
  // The heat pump drives a water temperature: no room setpoint at all.
  const pump = setup(HEAT_PUMP_UNIT);
  pump.unit.power = 'off';
  await assert.rejects(
    setClimate(pump.unit, { power: 'on', temperature: 21 }, pump.sendCommand),
    /no room temperature setpoint/,
  );
  assert.deepEqual(pump.sent, [], 'the unit was not switched on for nothing');

  const split = setup();
  await assert.rejects(
    setClimate(split.unit, { mode: 'dry', fan_speed: 2 }, split.sendCommand),
    /no manual fan speed/,
  );
  await assert.rejects(
    setClimate(split.unit, { mode: 'turbo' }, split.sendCommand),
    /Unknown mode/,
  );
  await assert.rejects(
    setClimate(split.unit, { temperature: 'warm' }, split.sendCommand),
    /must be a number/,
  );
  assert.deepEqual(split.sent, []);
});

test('an offline unit is refused', async () => {
  const { unit, sendCommand } = setup(OFFLINE_UNIT);
  await assert.rejects(setClimate(unit, { power: 'on' }, sendCommand), /offline/);
});

test('empty fields keep what the unit does', async () => {
  const { unit, sent, sendCommand } = setup();
  await setClimate(
    unit,
    { power: 'on', mode: 'unchanged', temperature: null, fan_speed: '' },
    sendCommand,
  );
  assert.deepEqual(sent, []);
});

test('the consumption adds up one unit or the whole account', () => {
  const units = parseUnits(structuredClone(ALL_DEVICES));
  const split = consumptionOutputs([units[0]]);
  assert.equal(split.today_kwh, 1.8);
  assert.equal(split.yesterday_kwh, 9.6);
  assert.equal(split.last_year_kwh, 204);
  // The other fixture units report no consumption: the account total is the
  // split unit's, not an error.
  assert.deepEqual(consumptionOutputs(units), split);
  assert.throws(() => consumptionOutputs([units[1]]), /No Daikin unit reports/);
});

test('the account counts what is reachable and what runs', () => {
  const units = parseUnits(structuredClone(ALL_DEVICES));
  assert.deepEqual(accountOutputs(units), {
    units_total: 3,
    units_online: 2,
    units_running: units.filter((unit) => unit.online && unit.power === 'on').length,
  });
});

/**
 * A store already holding the account, read `age` ms ago, and a Daikin client
 * reporting `remainingDay` calls left today.
 * @param {{ age?: number, remainingDay?: number|null, now?: number }} [options] the situation
 * @returns {object} the store, the api, the clock and the read counter
 */
function refreshSetup({ age = 0, remainingDay = 150, now = 1_000_000_000 } = {}) {
  const units = parseUnits(structuredClone(ALL_DEVICES));
  const store = { units, lastRefreshAt: age === null ? 0 : now - age };
  const api = { rateLimits: { remainingDay } };
  const reads = { count: 0 };
  const refresh = async () => {
    reads.count += 1;
    store.lastRefreshAt = now;
    api.rateLimits = { remainingDay: remainingDay === null ? null : remainingDay - 1 };
  };
  return { store, api, refresh, reads, now: () => now };
}

test('refresh_account reads at most once every 10 minutes', async () => {
  assert.equal(MIN_FORCED_REFRESH_MS, 600_000);
  // A scene every minute: the read of 9 minutes ago is served, not renewed.
  const recent = refreshSetup({ age: 9 * 60_000 });
  const { verdict, outputs } = await refreshAccount(recent);
  assert.equal(verdict, 'recent');
  assert.equal(recent.reads.count, 0, 'no call spent');
  assert.equal(outputs.data_age_seconds, 540, 'the scene learns how old the data is');
  assert.equal(outputs.api_calls_left, 150);
  assert.equal(outputs.units_total, 3);

  const stale = refreshSetup({ age: 10 * 60_000 });
  const fresh = await refreshAccount(stale);
  assert.equal(fresh.verdict, 'read');
  assert.equal(stale.reads.count, 1);
  assert.equal(fresh.outputs.data_age_seconds, 0);
  assert.equal(fresh.outputs.api_calls_left, 149, 'the quota after the read');
});

test('refresh_account leaves the last calls of the day to the schedule', async () => {
  const low = refreshSetup({ age: 60 * 60_000, remainingDay: 20 });
  const { verdict, outputs } = await refreshAccount(low);
  assert.equal(verdict, 'quota_low');
  assert.equal(low.reads.count, 0);
  assert.equal(outputs.data_age_seconds, 3600);
  assert.equal(outputs.api_calls_left, 20);

  assert.equal(
    forcedRefreshVerdict({ lastRefreshAt: 1, remainingDay: 21, now: MIN_FORCED_REFRESH_MS + 1 }),
    'read',
  );
  assert.equal(
    forcedRefreshVerdict({ lastRefreshAt: 1, remainingDay: null, now: MIN_FORCED_REFRESH_MS + 1 }),
    'read',
    'a quota Daikin never reported does not block the read',
  );
});

test('refresh_account reads when nothing was ever read, whatever the quota', async () => {
  // There is no snapshot to answer with: one read is the only answer.
  const empty = refreshSetup({ age: null, remainingDay: 3 });
  const { verdict, outputs } = await refreshAccount(empty);
  assert.equal(verdict, 'read');
  assert.equal(empty.reads.count, 1);
  assert.equal(outputs.data_age_seconds, 0);
});

test('refresh_account returns exactly the outputs the manifest declares', async () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  const declared = manifest.scene_actions
    .find((action) => action.key === SCENE_ACTION.REFRESH_ACCOUNT)
    .outputs.map((output) => output.key)
    .sort();
  const { outputs } = await refreshAccount(refreshSetup({ age: 0 }));
  assert.deepEqual(Object.keys(outputs).sort(), declared);
});

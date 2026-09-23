import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from '../src/daikin/model.js';
import { FEATURE, buildCommands } from '../src/devices/index.js';
import { AC_MODE } from '../src/mapping.js';
import { accountOutputs, consumptionOutputs, setClimate } from '../src/sceneActions.js';
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

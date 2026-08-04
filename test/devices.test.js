import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import { parseUnits } from '../src/daikin/model.js';
import {
  FEATURE,
  buildAllStates,
  buildCommands,
  buildDiscoveredDevices,
  buildStates,
  buildTransportEntries,
  deviceExternalId,
  featureKeyOf,
  findUnitByDevice,
} from '../src/devices/index.js';
import { AC_FAN_SPEED, AC_MODE, AC_SWING } from '../src/mapping.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  ALL_DEVICES,
  HEAT_PUMP_UNIT,
  OFFLINE_UNIT,
  SPLIT_UNIT,
} from './fixtures/gatewayDevices.js';

const gladys = createFakeGladys();
const FULL = { fanAndSwing: true };
const BASE = { fanAndSwing: false };

const splitUnit = () => parseUnits([SPLIT_UNIT])[0];
const featureOf = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`));
const stateOf = (states, key) =>
  states.find((state) => state.device_feature_external_id.endsWith(`:${key}`))?.state;

test('one Gladys device is published per Daikin climate unit', () => {
  const devices = buildDiscoveredDevices(gladys, parseUnits(ALL_DEVICES), FULL);
  assert.equal(devices.length, 3);
  const ids = devices.map((device) => device.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two devices may share an external_id');
  for (const device of devices) {
    assert.ok(device.name.length > 0);
    assert.ok(device.external_id.startsWith('ext:daikin-cloud:'));
    assert.ok(device.features.length > 0);
    assert.equal(device.poll_frequency, undefined, 'the integration owns its own schedule');
  }
});

test('a split unit exposes the full air conditioning catalog', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.deepEqual(
    keys.sort(),
    [
      FEATURE.FAN_SPEED,
      FEATURE.MODE,
      FEATURE.OUTDOOR_TEMPERATURE,
      FEATURE.POWER,
      FEATURE.ROOM_TEMPERATURE,
      FEATURE.SWING_HORIZONTAL,
      FEATURE.SWING_VERTICAL,
      FEATURE.TARGET_TEMPERATURE,
    ].sort(),
  );
});

test('the on/off feature is a writable air conditioning binary', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const power = featureOf(device, FEATURE.POWER);
  assert.equal(power.category, DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING);
  assert.equal(power.type, DEVICE_FEATURE_TYPES.AIR_CONDITIONING.BINARY);
  assert.equal(power.read_only, false);
  assert.equal(power.has_feedback, true);
});

test('the target temperature spans every mode the unit can reach', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const target = featureOf(device, FEATURE.TARGET_TEMPERATURE);
  // heating goes down to 10, cooling up to 32
  assert.equal(target.min, 10);
  assert.equal(target.max, 32);
  assert.equal(target.type, DEVICE_FEATURE_TYPES.AIR_CONDITIONING.TARGET_TEMPERATURE);
});

test('supported options restrict the modes to what the unit accepts', () => {
  const [device] = buildDiscoveredDevices(gladys, parseUnits([OFFLINE_UNIT]), FULL);
  const mode = featureOf(device, FEATURE.MODE);
  assert.deepEqual(
    mode.supported_options.map((option) => option.value),
    [AC_MODE.COOLING, AC_MODE.HEATING],
    'this unit has no auto, dry or fan-only mode',
  );
  assert.deepEqual(
    mode.supported_options.map((option) => option.sort_order),
    [0, 1],
  );
  assert.equal(mode.min, AC_MODE.COOLING);
  assert.equal(mode.max, AC_MODE.HEATING);
});

test('a unit without a room setpoint or a fan only exposes what it has', () => {
  const [device] = buildDiscoveredDevices(gladys, parseUnits([HEAT_PUMP_UNIT]), FULL);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.deepEqual(keys.sort(), [FEATURE.MODE, FEATURE.OUTDOOR_TEMPERATURE, FEATURE.POWER].sort());
});

test('an older Gladys gets the catalog it understands', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], BASE);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(!keys.includes(FEATURE.FAN_SPEED), 'fan speed needs Gladys 4.84.3+');
  assert.ok(!keys.includes(FEATURE.SWING_VERTICAL), 'swing needs Gladys 4.84.3+');
  assert.ok(keys.includes(FEATURE.POWER) && keys.includes(FEATURE.TARGET_TEMPERATURE));
});

test('the published device carries the Daikin identifiers as params', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const params = Object.fromEntries(device.params.map((param) => [param.name, param.value]));
  assert.equal(params.daikin_device_id, SPLIT_UNIT.id);
  assert.equal(params.daikin_embedded_id, 'climateControl');
  assert.equal(params.daikin_model, 'dx23');
});

test('states mirror the unit as the Daikin cloud reports it', () => {
  const states = buildStates(gladys, splitUnit(), FULL);
  assert.equal(stateOf(states, FEATURE.POWER), 1);
  assert.equal(stateOf(states, FEATURE.MODE), AC_MODE.COOLING);
  assert.equal(stateOf(states, FEATURE.TARGET_TEMPERATURE), 22);
  assert.equal(stateOf(states, FEATURE.ROOM_TEMPERATURE), 24.5);
  assert.equal(stateOf(states, FEATURE.OUTDOOR_TEMPERATURE), 31);
  assert.equal(stateOf(states, FEATURE.FAN_SPEED), AC_FAN_SPEED.MID);
  assert.equal(stateOf(states, FEATURE.SWING_HORIZONTAL), AC_SWING.OFF);
  assert.equal(stateOf(states, FEATURE.SWING_VERTICAL), AC_SWING.SWING);
});

test('a value Gladys has no word for is left out rather than published wrong', () => {
  const unit = splitUnit();
  unit.fan.direction.vertical.value = 'windNice';
  const states = buildStates(gladys, unit, FULL);
  assert.equal(stateOf(states, FEATURE.SWING_VERTICAL), undefined);
  assert.equal(
    stateOf(states, FEATURE.SWING_HORIZONTAL),
    AC_SWING.OFF,
    'the other axis is unaffected',
  );
});

test('buildAllStates batches every unit', () => {
  const states = buildAllStates(gladys, parseUnits(ALL_DEVICES), FULL);
  const devices = new Set(
    states.map((state) => state.device_feature_external_id.split(':').slice(0, 4).join(':')),
  );
  assert.equal(devices.size, 3);
});

test('a device external_id routes back to the unit that owns it', () => {
  const units = parseUnits(ALL_DEVICES);
  for (const unit of units) {
    const found = findUnitByDevice(gladys, units, { external_id: deviceExternalId(gladys, unit) });
    assert.equal(found, unit);
  }
  assert.equal(
    findUnitByDevice(gladys, units, { external_id: 'ext:daikin-cloud:climate:nope' }),
    undefined,
  );
});

test('a feature external_id gives its feature key back', () => {
  const unit = splitUnit();
  const [device] = buildDiscoveredDevices(gladys, [unit], FULL);
  const power = featureOf(device, FEATURE.POWER);
  assert.equal(featureKeyOf(gladys, unit, power.external_id), FEATURE.POWER);
  assert.equal(featureKeyOf(gladys, unit, 'ext:daikin-cloud:climate:other:power'), null);
});

test('the transport badge reflects what the Daikin cloud can reach', () => {
  const entries = buildTransportEntries(gladys, parseUnits(ALL_DEVICES));
  const valid = Object.values(DEVICE_TRANSPORTS);
  for (const entry of entries) {
    assert.ok(entry.external_id);
    assert.ok(valid.includes(entry.transport));
  }
  assert.equal(entries[0].transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(
    entries[0].degraded,
    undefined,
    'a nominal entry clears any previous degraded state',
  );
  assert.equal(entries[1].transport, DEVICE_TRANSPORTS.UNREACHABLE, 'the offline unit');
});

test('a reachable unit reporting a fault is flagged degraded', () => {
  const unit = splitUnit();
  unit.inErrorState = true;
  const [entry] = buildTransportEntries(gladys, [unit]);
  assert.equal(entry.transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(entry.degraded, true);
  assert.ok(entry.message.en.length <= 200, 'tooltip messages are capped at 200 characters');
  assert.ok(entry.message.fr);
});

test('turning a unit on and off writes onOffMode', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.POWER, 1), {
    writes: [{ characteristic: 'onOffMode', value: 'on' }],
    state: 1,
  });
  assert.deepEqual(buildCommands(unit, FEATURE.POWER, 0), {
    writes: [{ characteristic: 'onOffMode', value: 'off' }],
    state: 0,
  });
});

test('changing the mode writes operationMode', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.MODE, AC_MODE.HEATING), {
    writes: [{ characteristic: 'operationMode', value: 'heating' }],
    state: AC_MODE.HEATING,
  });
});

test('a mode the unit does not have is refused with a readable error', () => {
  const unit = parseUnits([OFFLINE_UNIT])[0];
  assert.throws(
    () => buildCommands(unit, FEATURE.MODE, AC_MODE.DRYING),
    /does not support the "dry" mode/,
  );
  assert.throws(() => buildCommands(unit, FEATURE.MODE, 99), /Unsupported air conditioning mode/);
});

test('the setpoint is written under the ACTIVE operation mode and snapped', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.TARGET_TEMPERATURE, 23.3), {
    writes: [
      {
        characteristic: 'temperatureControl',
        path: '/operationModes/cooling/setpoints/roomTemperature',
        value: 23.5,
      },
    ],
    state: 23.5,
  });
});

test('the setpoint is clamped to the range of the active mode', () => {
  const unit = splitUnit();
  const { writes } = buildCommands(unit, FEATURE.TARGET_TEMPERATURE, 40);
  assert.equal(writes[0].value, 32, 'cooling tops at 32 on this unit');
});

test('a unit without a room setpoint refuses the command', () => {
  const unit = parseUnits([HEAT_PUMP_UNIT])[0];
  assert.throws(
    () => buildCommands(unit, FEATURE.TARGET_TEMPERATURE, 21),
    /no room temperature setpoint/,
  );
});

test('a fixed fan speed writes the mode then the level, in that order', () => {
  const unit = splitUnit();
  const { writes, state } = buildCommands(unit, FEATURE.FAN_SPEED, AC_FAN_SPEED.HIGH);
  assert.deepEqual(writes, [
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
  assert.equal(state, AC_FAN_SPEED.HIGH);
});

test('the auto fan speed writes the mode alone', () => {
  const unit = splitUnit();
  const { writes, state } = buildCommands(unit, FEATURE.FAN_SPEED, AC_FAN_SPEED.AUTO);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, 'auto');
  assert.equal(state, AC_FAN_SPEED.AUTO);
});

test('moving the louvers writes the right axis', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.SWING_HORIZONTAL, AC_SWING.SWING), {
    writes: [
      {
        characteristic: 'fanControl',
        path: '/operationModes/cooling/fanDirection/horizontal/currentMode',
        value: 'swing',
      },
    ],
    state: AC_SWING.SWING,
  });
});

test('a unit without louvers refuses the swing command', () => {
  const unit = parseUnits([HEAT_PUMP_UNIT])[0];
  assert.throws(
    () => buildCommands(unit, FEATURE.SWING_VERTICAL, AC_SWING.SWING),
    /no vertical louvers/,
  );
});

test('an unknown feature is a clear error, not a silent no-op', () => {
  assert.throws(() => buildCommands(splitUnit(), 'nope', 1), /Unknown feature/);
});

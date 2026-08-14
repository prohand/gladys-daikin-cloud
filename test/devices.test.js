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
  featureIdsByExternalId,
  featureKeyOf,
  findUnitByDevice,
} from '../src/devices/index.js';
import { AC_MODE, AC_SWING, FAN_ROCK_SETTING } from '../src/mapping.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  ALL_DEVICES,
  HEAT_PUMP_UNIT,
  OFFLINE_UNIT,
  SPLIT_UNIT,
} from './fixtures/gatewayDevices.js';

const gladys = createFakeGladys();
const FULL = { fanCategory: true, supportedOptions: true, acSwing: true };
const BASE = { fanCategory: false, supportedOptions: false, acSwing: false };
// The richest catalog: what a Gladys 4.66+ takes, energy monitoring included.
const ENERGY = { ...FULL, energyMonitoring: true };

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

test('every published feature carries the fields Gladys requires', () => {
  // These columns are NOT NULL in the Gladys schema — for EVERY feature, a
  // binary one included. A feature missing one of them makes the device
  // creation fail with a 422 the user cannot do anything about.
  for (const capabilities of [ENERGY, FULL, BASE]) {
    for (const device of buildDiscoveredDevices(
      gladys,
      parseUnits(ALL_DEVICES),
      capabilities,
      new Map(),
    )) {
      for (const feature of device.features) {
        const where = `${device.name} / ${feature.name}`;
        assert.equal(typeof feature.name, 'string', `${where}: name`);
        assert.equal(typeof feature.min, 'number', `${where}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${where}: max must be a number`);
        assert.ok(feature.min <= feature.max, `${where}: min must not exceed max`);
        assert.equal(typeof feature.read_only, 'boolean', `${where}: read_only`);
        assert.equal(typeof feature.has_feedback, 'boolean', `${where}: has_feedback`);
        assert.equal(typeof feature.keep_history, 'boolean', `${where}: keep_history`);
      }
    }
  }
});

test('the on/off feature is bounded to the two values it can take', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const power = featureOf(device, FEATURE.POWER);
  assert.equal(power.min, 0);
  assert.equal(power.max, 1);
});

test('a split unit exposes the full air conditioning catalog', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.deepEqual(
    keys.sort(),
    [
      FEATURE.ECONO,
      FEATURE.ENERGY_MONTH,
      FEATURE.ENERGY_TODAY,
      FEATURE.ENERGY_YEAR,
      FEATURE.FAN_LEVEL,
      FEATURE.MODE,
      FEATURE.OUTDOOR_TEMPERATURE,
      FEATURE.POWER,
      FEATURE.POWER_SWITCH,
      FEATURE.POWERFUL,
      FEATURE.ROOM_TEMPERATURE,
      FEATURE.STREAMER,
      FEATURE.DRY_KEEP,
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

// The bug this guards against: a scene "turn off the switches" resolves the
// device to the FIRST (switch, binary) feature Gladys finds — in whatever order
// the database hands the features back. With the comfort toggles published as
// switches, that scene switched off the Powerful mode and left the unit running.
test('the unit has exactly one switch binary, and it is its power', () => {
  for (const unit of [splitUnit(), ...parseUnits([HEAT_PUMP_UNIT, OFFLINE_UNIT])]) {
    const [device] = buildDiscoveredDevices(gladys, [unit], FULL);
    const switches = device.features.filter(
      (feature) =>
        feature.category === DEVICE_FEATURE_CATEGORIES.SWITCH &&
        feature.type === DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    );
    assert.equal(switches.length, 1, `${unit.name} must expose one and only one switch`);
    assert.equal(switches[0].external_id, featureOf(device, FEATURE.POWER_SWITCH).external_id);
    assert.equal(switches[0].read_only, false);
    assert.equal(switches[0].has_feedback, true);
    // The air conditioning binary already historises the same signal.
    assert.equal(switches[0].keep_history, false);
  }
});

test('both faces of the power report the same state', () => {
  const states = buildStates(gladys, splitUnit(), FULL);
  assert.equal(stateOf(states, FEATURE.POWER), 1);
  assert.equal(stateOf(states, FEATURE.POWER_SWITCH), 1);
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
  assert.deepEqual(
    keys.sort(),
    [FEATURE.MODE, FEATURE.OUTDOOR_TEMPERATURE, FEATURE.POWER, FEATURE.POWER_SWITCH].sort(),
  );
});

test('an older Gladys gets the catalog it understands', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], BASE);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(!keys.includes(FEATURE.FAN_LEVEL), 'the fan category needs Gladys 4.79+');
  assert.ok(!keys.includes(FEATURE.FAN_ROCK), 'the fan category needs Gladys 4.79+');
  assert.ok(keys.includes(FEATURE.POWER) && keys.includes(FEATURE.TARGET_TEMPERATURE));
});

test('the fan controls survive a unit discovered while it dehumidifies', () => {
  // Daikin declares no manual level in `dry` and no louvers in several modes:
  // the catalog must come from the union, not from the active mode.
  const drying = structuredClone(SPLIT_UNIT);
  const climate = drying.managementPoints.find((p) => p.managementPointType === 'climateControl');
  climate.operationMode.value = 'dry';
  const [device] = buildDiscoveredDevices(gladys, parseUnits([drying]), FULL);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(keys.includes(FEATURE.FAN_LEVEL), 'the speed control must not vanish');
  assert.ok(keys.includes(FEATURE.SWING_HORIZONTAL));
  assert.ok(keys.includes(FEATURE.SWING_VERTICAL));
});

test('the fan speed slider carries the widest range the unit declares', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  const level = featureOf(device, FEATURE.FAN_LEVEL);
  assert.equal(level.min, 1);
  assert.equal(level.max, 5);
  assert.equal(level.category, 'fan');
  assert.equal(level.type, 'speed');
});

test('each louver axis is its own writable feature', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  for (const [key, type] of [
    [FEATURE.SWING_HORIZONTAL, 'swing-horizontal'],
    [FEATURE.SWING_VERTICAL, 'swing-vertical'],
  ]) {
    const feature = featureOf(device, key);
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING);
    assert.equal(feature.type, type);
    assert.equal(feature.read_only, false);
    assert.deepEqual(
      feature.supported_options.map((option) => option.value),
      [AC_SWING.OFF, AC_SWING.SWING],
    );
  }
});

test('the comfort toggles are on/off controls, and follow what Daikin allows', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  for (const key of [FEATURE.POWERFUL, FEATURE.ECONO, FEATURE.STREAMER]) {
    const feature = featureOf(device, key);
    // Deliberately NOT the switch category: Gladys resolves "turn off the
    // switches" to the first switch binary of the device, and that slot
    // belongs to the unit's power.
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.UNKNOWN);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.SENSOR.BINARY);
    assert.equal(feature.read_only, false, 'these three are settable on this unit');
  }
  // Daikin reports "keep dry" read-only on this model: publish it as a sensor
  // rather than a switch the unit would refuse.
  const dryKeep = featureOf(device, FEATURE.DRY_KEEP);
  assert.equal(dryKeep.read_only, true);
  assert.equal(dryKeep.has_feedback, false);
});

test('a unit without a given comfort mode does not get its feature', () => {
  const [device] = buildDiscoveredDevices(gladys, parseUnits([OFFLINE_UNIT]), FULL);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(!keys.includes(FEATURE.POWERFUL));
  assert.ok(!keys.includes(FEATURE.DRY_KEEP), 'this gateway has no indoor unit block');
});

test('toggling a comfort mode writes its characteristic', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.POWERFUL, 1), {
    writes: [{ characteristic: 'powerfulMode', value: 'on' }],
    states: [{ featureKey: FEATURE.POWERFUL, state: 1 }],
  });
  assert.deepEqual(buildCommands(unit, FEATURE.ECONO, 0), {
    writes: [{ characteristic: 'econoMode', value: 'off' }],
    states: [{ featureKey: FEATURE.ECONO, state: 0 }],
  });
});

test('a read-only comfort mode is refused with a readable error', () => {
  assert.throws(() => buildCommands(splitUnit(), FEATURE.DRY_KEEP, 1), /read-only on this unit/);
});

test('a comfort mode the unit does not have is refused', () => {
  const unit = parseUnits([OFFLINE_UNIT])[0];
  assert.throws(() => buildCommands(unit, FEATURE.STREAMER, 1), /has no streamer mode/);
});

test('the keep-dry write is addressed to the indoor unit, not the climate point', () => {
  const unit = splitUnit();
  unit.toggles.dryKeep.settable = true;
  const { writes } = buildCommands(unit, FEATURE.DRY_KEEP, 1);
  assert.equal(writes[0].characteristic, 'dryKeepSetting');
  assert.equal(writes[0].embeddedId, 'indoorUnit', 'it lives on another management point');
});

test('steering one louver axis writes only that axis', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.SWING_VERTICAL, AC_SWING.OFF), {
    writes: [
      {
        characteristic: 'fanControl',
        path: '/operationModes/cooling/fanDirection/vertical/currentMode',
        value: 'stop',
      },
    ],
    states: [{ featureKey: FEATURE.SWING_VERTICAL, state: AC_SWING.OFF }],
  });
});

test('the consumption is published as kWh energy sensors', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], FULL);
  for (const key of [FEATURE.ENERGY_TODAY, FEATURE.ENERGY_MONTH, FEATURE.ENERGY_YEAR]) {
    const feature = featureOf(device, key);
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY);
    assert.equal(feature.unit, 'kilowatt-hour');
    // Daikin period totals RESET: today goes back to zero at midnight, so
    // these are sensors, never an ever-growing meter index.
    assert.equal(feature.read_only, true);
    assert.equal(feature.keep_history, true);
  }
  const states = buildStates(gladys, splitUnit(), FULL);
  assert.equal(stateOf(states, FEATURE.ENERGY_TODAY), 1.8);
  assert.equal(stateOf(states, FEATURE.ENERGY_YEAR), 84);
});

test('the energy monitoring pair hangs off the counter of the day, and off it alone', () => {
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], ENERGY, new Map());
  const index = featureOf(device, FEATURE.ENERGY_TODAY);
  const consumption = featureOf(device, FEATURE.ENERGY_TODAY_CONSUMPTION);
  const cost = featureOf(device, FEATURE.ENERGY_TODAY_COST);

  assert.equal(consumption.type, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION);
  assert.equal(consumption.unit, 'kilowatt-hour');
  assert.equal(cost.type, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION_COST);
  assert.equal(cost.unit, 'euro');

  // The chain the core walks: cost -> consumption -> index.
  assert.equal(consumption.energy_parent_id, index.id);
  assert.equal(cost.energy_parent_id, consumption.id);

  // The monthly and the yearly counters get no pair of their own: the same
  // kWh would be counted twice in the energy dashboard.
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.deepEqual(
    keys.filter((key) => key.includes('consumption') || key.includes('cost')),
    [FEATURE.ENERGY_TODAY_CONSUMPTION, FEATURE.ENERGY_TODAY_COST],
  );

  // Nothing parents the index itself: that link belongs to the user, in
  // Settings -> Energy, and re-publishing must not undo it.
  assert.equal('energy_parent_id' in index, false);

  // These are written by the Gladys 30-minute job, never by this integration.
  const states = buildStates(gladys, splitUnit(), ENERGY).map(
    (state) => state.device_feature_external_id,
  );
  assert.ok(!states.includes(consumption.external_id));
  assert.ok(!states.includes(cost.external_id));
});

test('a feature Gladys already stores keeps the id Gladys gave it', () => {
  // Publishing another id would rewrite the primary key the states of that
  // feature hang on. Only a feature Gladys has never seen is named here.
  const [reference] = buildDiscoveredDevices(gladys, [splitUnit()], ENERGY, new Map());
  const known = new Map([[featureOf(reference, FEATURE.ENERGY_TODAY).external_id, 'from-gladys']]);

  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], ENERGY, known);
  const index = featureOf(device, FEATURE.ENERGY_TODAY);
  assert.equal('id' in index, false, 'a known feature is published without an id');
  assert.equal(featureOf(device, FEATURE.ENERGY_TODAY_CONSUMPTION).energy_parent_id, 'from-gladys');

  // ...and an unknown one always derives the same id, so republishing never
  // moves a feature Gladys created from a previous payload.
  const [again] = buildDiscoveredDevices(gladys, [splitUnit()], ENERGY, new Map());
  assert.equal(
    featureOf(again, FEATURE.ENERGY_TODAY).id,
    featureOf(reference, FEATURE.ENERGY_TODAY).id,
  );
  assert.match(featureOf(again, FEATURE.ENERGY_TODAY_CONSUMPTION).id, /^[0-9a-f-]{36}$/);
});

test('the energy monitoring pair is left out when the ids could not be read', () => {
  // Publishing it against ids nothing could be checked against risks pointing
  // at a row that already exists: it comes back on the next publish.
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], ENERGY, null);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(keys.includes(FEATURE.ENERGY_TODAY));
  assert.ok(!keys.includes(FEATURE.ENERGY_TODAY_CONSUMPTION));
  assert.ok(!keys.includes(FEATURE.ENERGY_TODAY_COST));
});

test('the ids of the created devices are indexed by feature external_id', () => {
  const ids = featureIdsByExternalId([
    { features: [{ external_id: 'ext:daikin-cloud:climate:1:power', id: 'uuid-power' }] },
    { features: [{ external_id: 'ext:daikin-cloud:climate:2:mode' }] },
    { features: null },
    null,
  ]);
  assert.equal(ids.get('ext:daikin-cloud:climate:1:power'), 'uuid-power');
  assert.equal(ids.size, 1, 'a feature without an id is not indexed');
  assert.equal(featureIdsByExternalId(undefined).size, 0);
});

test('a unit reporting no consumption gets no energy features', () => {
  const [device] = buildDiscoveredDevices(gladys, parseUnits([OFFLINE_UNIT]), FULL);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(!keys.includes(FEATURE.ENERGY_TODAY));
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
  assert.equal(stateOf(states, FEATURE.FAN_LEVEL), 3);
  assert.equal(stateOf(states, FEATURE.SWING_HORIZONTAL), AC_SWING.OFF);
  assert.equal(stateOf(states, FEATURE.SWING_VERTICAL), AC_SWING.SWING);
  assert.equal(stateOf(states, FEATURE.STREAMER), 1);
  assert.equal(stateOf(states, FEATURE.ECONO), 0);
  assert.equal(stateOf(states, FEATURE.DRY_KEEP), 1);
});

test('a Daikin comfort airflow is left out rather than published wrong', () => {
  const unit = splitUnit();
  unit.fan.current.direction.vertical.value = 'windNice';
  const states = buildStates(gladys, unit, FULL);
  assert.equal(stateOf(states, FEATURE.SWING_VERTICAL), undefined);
  assert.equal(stateOf(states, FEATURE.SWING_HORIZONTAL), AC_SWING.OFF, 'the other axis is fine');
});

test('on an older Gladys the louvers fold into one oscillation feature', () => {
  const capabilities = { fanCategory: true, supportedOptions: false, acSwing: false };
  const [device] = buildDiscoveredDevices(gladys, [splitUnit()], capabilities);
  const keys = device.features.map((feature) => feature.external_id.split(':').pop());
  assert.ok(keys.includes(FEATURE.FAN_ROCK), 'the bitmap fallback');
  assert.ok(!keys.includes(FEATURE.SWING_HORIZONTAL), 'per-axis needs 4.84.3');
  const states = buildStates(gladys, splitUnit(), capabilities);
  assert.equal(stateOf(states, FEATURE.FAN_ROCK), FAN_ROCK_SETTING.UP_DOWN);
});

test('the fan level is left out while the unit runs in auto', () => {
  const unit = splitUnit();
  unit.fan.current.speed.currentMode = 'auto';
  const states = buildStates(gladys, unit, FULL);
  assert.equal(stateOf(states, FEATURE.FAN_LEVEL), undefined, 'auto is not a level');
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
    states: [
      { featureKey: FEATURE.POWER, state: 1 },
      { featureKey: FEATURE.POWER_SWITCH, state: 1 },
    ],
  });
  assert.deepEqual(buildCommands(unit, FEATURE.POWER, 0), {
    writes: [{ characteristic: 'onOffMode', value: 'off' }],
    states: [
      { featureKey: FEATURE.POWER, state: 0 },
      { featureKey: FEATURE.POWER_SWITCH, state: 0 },
    ],
  });
});

// What a scene action "turn off the switches" ends up doing: Gladys resolves
// the device to its switch binary, and that feature must drive the unit itself,
// not one of the comfort toggles.
test('the switch face of the power writes onOffMode too, and moves both features', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.POWER_SWITCH, 0), {
    writes: [{ characteristic: 'onOffMode', value: 'off' }],
    states: [
      { featureKey: FEATURE.POWER, state: 0 },
      { featureKey: FEATURE.POWER_SWITCH, state: 0 },
    ],
  });
});

test('changing the mode writes operationMode', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.MODE, AC_MODE.HEATING), {
    writes: [{ characteristic: 'operationMode', value: 'heating' }],
    states: [{ featureKey: FEATURE.MODE, state: AC_MODE.HEATING }],
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
    states: [{ featureKey: FEATURE.TARGET_TEMPERATURE, state: 23.5 }],
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

test('setting a manual level forces the fixed mode first, then writes the level', () => {
  const unit = splitUnit();
  const { writes, states } = buildCommands(unit, FEATURE.FAN_LEVEL, 5);
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
  assert.deepEqual(states, [{ featureKey: FEATURE.FAN_LEVEL, state: 5 }]);
});

test('the oscillation drives both louver axes in one command', () => {
  const unit = splitUnit();
  assert.deepEqual(buildCommands(unit, FEATURE.FAN_ROCK, FAN_ROCK_SETTING.LEFT_RIGHT), {
    writes: [
      {
        characteristic: 'fanControl',
        path: '/operationModes/cooling/fanDirection/horizontal/currentMode',
        value: 'swing',
      },
      {
        characteristic: 'fanControl',
        path: '/operationModes/cooling/fanDirection/vertical/currentMode',
        value: 'stop',
      },
    ],
    states: [{ featureKey: FEATURE.FAN_ROCK, state: FAN_ROCK_SETTING.LEFT_RIGHT }],
  });
});

test('a unit without louvers refuses the oscillation command', () => {
  const unit = parseUnits([HEAT_PUMP_UNIT])[0];
  assert.throws(
    () => buildCommands(unit, FEATURE.FAN_ROCK, FAN_ROCK_SETTING.UP_DOWN),
    /no steerable louvers/,
  );
});

test('a unit without a manual level refuses one', () => {
  const unit = parseUnits([HEAT_PUMP_UNIT])[0];
  assert.throws(() => buildCommands(unit, FEATURE.FAN_LEVEL, 3), /no manual fan speed/);
});

test('an unknown feature is a clear error, not a silent no-op', () => {
  assert.throws(() => buildCommands(splitUnit(), 'nope', 1), /Unknown feature/);
});

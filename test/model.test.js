import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConsumption, parseUnits } from '../src/daikin/model.js';
import {
  ALL_DEVICES,
  HEAT_PUMP_UNIT,
  OFFLINE_UNIT,
  SPLIT_UNIT,
} from './fixtures/gatewayDevices.js';

test('only the climateControl management points become units', () => {
  const units = parseUnits(ALL_DEVICES);
  assert.equal(units.length, 3, 'gateway, indoorUnit and domesticHotWaterTank are ignored');
  assert.deepEqual(
    units.map((unit) => unit.name),
    ['Living room', 'Bedroom', 'Heat pump'],
  );
});

test('the platform id pairs the gateway device with its management point', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  assert.equal(unit.platformId, `${SPLIT_UNIT.id}_climateControl`);
  assert.equal(unit.deviceId, SPLIT_UNIT.id);
  assert.equal(unit.embeddedId, 'climateControl');
});

test('a split unit exposes its power, mode, setpoints and sensors', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  assert.equal(unit.power, 'on');
  assert.equal(unit.operationMode, 'cooling');
  assert.deepEqual(unit.operationModes, ['auto', 'dry', 'cooling', 'heating', 'fanOnly']);
  assert.equal(unit.roomTemperature, 24.5);
  assert.equal(unit.outdoorTemperature, 31);
  assert.equal(unit.online, true);
  assert.equal(unit.inErrorState, false);
});

test('the active setpoint is the one of the current operation mode', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  assert.deepEqual(unit.setpoint, { value: 22, min: 18, max: 32, step: 0.5, settable: true });
  assert.equal(unit.setpoints.heating.value, 21);
  assert.equal(unit.setpoints.heating.min, 10);
  assert.equal(unit.setpoints.dry, undefined, 'dry has no room setpoint on this model');
});

test('the current fan block describes the operation mode the unit is running', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  assert.equal(unit.fan.current.speed.currentMode, 'fixed');
  assert.deepEqual(unit.fan.current.speed.modes, ['quiet', 'auto', 'fixed']);
  assert.deepEqual(unit.fan.current.speed.fixed, { value: 3, min: 1, max: 5, step: 1 });
  assert.equal(unit.fan.current.direction.vertical.value, 'swing');
  assert.deepEqual(unit.fan.current.direction.horizontal.values, ['stop', 'swing']);
});

test('the fan capabilities are the union over every operation mode', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  // On this unit `dry` offers only the auto airflow and no louvers, while
  // `heating` has a manual level but no louver block at all: the capabilities
  // must still describe everything the hardware can do.
  assert.deepEqual(unit.fan.capabilities.speedModes.sort(), ['auto', 'fixed', 'quiet']);
  // A range, not a reading: the current value belongs to the active mode.
  assert.deepEqual(unit.fan.capabilities.fixed, { min: 1, max: 5, step: 1 });
  assert.deepEqual(unit.fan.capabilities.axes, {
    horizontal: ['stop', 'swing'],
    vertical: ['stop', 'swing', 'windNice'],
  });
});

test('a unit sitting in Drying keeps every fan capability', () => {
  // The regression this guards: Daikin declares no manual level in `dry`, so
  // reading the active mode alone made the speed control vanish for anyone
  // who discovered their device while the unit was dehumidifying.
  const drying = structuredClone(SPLIT_UNIT);
  const climate = drying.managementPoints.find((p) => p.managementPointType === 'climateControl');
  climate.operationMode.value = 'dry';
  const [unit] = parseUnits([drying]);

  assert.equal(unit.fan.current.speed.currentMode, 'auto', 'dry runs on auto only');
  assert.equal(unit.fan.current.speed.fixed, null, 'dry has no manual level');
  assert.ok(
    unit.fan.capabilities.speedModes.includes('fixed'),
    'but the unit does have a manual level in other modes',
  );
  assert.deepEqual(unit.fan.capabilities.fixed, { min: 1, max: 5, step: 1 });
});

test('the unit records every characteristic it declares, for the diagnostics', () => {
  // This is what lets the test action answer "your model does not report it"
  // instead of leaving the user unable to tell that from a mapping gap.
  const [unit] = parseUnits([SPLIT_UNIT]);
  assert.ok(unit.characteristics.climateControl.includes('econoMode'));
  assert.ok(unit.characteristics.climateControl.includes('isPowerfulModeActive'));
  assert.ok(unit.characteristics.indoorUnit.includes('dryKeepSetting'));
  assert.ok(
    !unit.characteristics.climateControl.includes('managementPointType'),
    'the keys describing the management point itself are noise',
  );
});

test('a unit missing a comfort characteristic simply has no toggle for it', () => {
  const stripped = structuredClone(SPLIT_UNIT);
  const climate = stripped.managementPoints.find((p) => p.managementPointType === 'climateControl');
  delete climate.econoMode;
  delete climate.streamerMode;
  const [unit] = parseUnits([stripped]);
  assert.ok(unit.toggles.powerful, 'the one it still declares');
  assert.equal(unit.toggles.econo, null);
  assert.equal(unit.toggles.streamer, null);
  assert.ok(!unit.characteristics.climateControl.includes('econoMode'));
});

test('the consumption counts the current period only, not the previous one', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  // `d` holds yesterday in its first 12 slots: counting the whole array would
  // report 1.8 + 9.6 kWh, and every dashboard would be wrong by a day.
  assert.equal(unit.energy.today, 1.8, '12 x 0.1 heating + 12 x 0.05 cooling');
  // `m` holds last year in its first 12 entries, worth 9 + 8 a month.
  assert.equal(unit.energy.thisYear, 84, '(1+2+...+12) heating + 12 x 0.5 cooling');
});

test('the month is read at its own index inside the current year', () => {
  const consumption = SPLIT_UNIT.managementPoints[1].consumptionData;
  // The fixture puts the month number in each of this year's heating slots,
  // and a flat 0.5 in the cooling ones.
  for (const [month, heating] of [
    [0, 1],
    [7, 8],
    [11, 12],
  ]) {
    const energy = parseConsumption(consumption, new Date(2026, month, 15));
    assert.equal(energy.thisMonth, heating + 0.5, `month ${month}`);
  }
});

test('a bucket Daikin has not measured yet counts as zero, not as a gap', () => {
  const consumption = {
    value: { electrical: { heating: { d: [...Array(12).fill(1), 0.4, null, null], m: null } } },
  };
  const energy = parseConsumption(consumption, new Date(2026, 0, 1));
  assert.equal(energy.today, 0.4);
  assert.equal(energy.thisYear, 0, 'a missing monthly array is not an error');
});

test('a unit reporting no consumption gets no energy at all', () => {
  assert.equal(parseConsumption(undefined), null);
  assert.equal(parseConsumption({ value: {} }), null);
  assert.equal(parseUnits([OFFLINE_UNIT])[0].energy, null);
});

test('an offline unit in error state is reported as such', () => {
  const [unit] = parseUnits([OFFLINE_UNIT]);
  assert.equal(unit.online, false);
  assert.equal(unit.inErrorState, true);
  assert.equal(unit.power, 'off');
});

test('a unit without a room setpoint or fan parses without throwing', () => {
  const [unit] = parseUnits([HEAT_PUMP_UNIT]);
  assert.deepEqual(unit.setpoints, {}, 'leavingWaterOffset is not a room temperature setpoint');
  assert.equal(unit.setpoint, null);
  assert.equal(unit.fan, null);
  assert.equal(unit.roomTemperature, null);
  assert.equal(unit.outdoorTemperature, 8);
});

test('a malformed payload never throws', () => {
  assert.deepEqual(parseUnits(), []);
  assert.deepEqual(parseUnits([null, {}, { managementPoints: 'nope' }]), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from '../src/daikin/model.js';
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

test('the fan block describes the current operation mode only', () => {
  const [unit] = parseUnits([SPLIT_UNIT]);
  assert.equal(unit.fan.speed.currentMode, 'fixed');
  assert.deepEqual(unit.fan.speed.modes, ['quiet', 'auto', 'fixed']);
  assert.deepEqual(unit.fan.speed.fixed, { value: 3, min: 1, max: 5, step: 1 });
  assert.equal(unit.fan.direction.vertical.value, 'swing');
  assert.deepEqual(unit.fan.direction.horizontal.values, ['stop', 'swing']);
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

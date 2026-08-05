import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AC_MODE,
  AC_SWING,
  FAN_MODE,
  FAN_ROCK_SETTING,
  fanLevelToDaikin,
  fanLevelToGladys,
  fanModeToDaikin,
  fanModeToGladys,
  modeToDaikin,
  modeToGladys,
  rockSettingBounds,
  rockSettingToDaikin,
  rockSettingToGladys,
  roundToStep,
  supportedFanModes,
  supportedSwings,
  swingToDaikin,
  swingToGladys,
} from '../src/mapping.js';

const speedBlock = (overrides = {}) => ({
  currentMode: 'fixed',
  modes: ['quiet', 'auto', 'fixed'],
  fixed: { value: 3, min: 1, max: 5, step: 1 },
  ...overrides,
});

const directionBlock = (overrides = {}) => ({
  horizontal: { value: 'stop', values: ['stop', 'swing'] },
  vertical: { value: 'stop', values: ['stop', 'swing'] },
  ...overrides,
});

test('the five Daikin operation modes map to the Gladys ones, both ways', () => {
  const pairs = [
    ['auto', AC_MODE.AUTO],
    ['cooling', AC_MODE.COOLING],
    ['heating', AC_MODE.HEATING],
    ['dry', AC_MODE.DRYING],
    ['fanOnly', AC_MODE.FAN],
  ];
  for (const [daikin, gladys] of pairs) {
    assert.equal(modeToGladys(daikin), gladys);
    assert.equal(modeToDaikin(gladys), daikin);
  }
});

test('a Daikin mode Gladys has no word for is not invented', () => {
  assert.equal(modeToGladys('humidification'), null);
  assert.equal(modeToGladys(null), null);
  assert.equal(modeToDaikin(42), null);
});

// --- Fan mode ----------------------------------------------------------------

test('the Daikin airflow modes read as Gladys fan modes', () => {
  assert.equal(fanModeToGladys(speedBlock({ currentMode: 'auto' })), FAN_MODE.AUTO);
  assert.equal(fanModeToGladys(speedBlock({ currentMode: 'quiet' })), FAN_MODE.LOW);
  assert.equal(fanModeToGladys(speedBlock({ currentMode: 'fixed' })), FAN_MODE.MEDIUM);
  assert.equal(fanModeToGladys(speedBlock({ currentMode: 'unknown' })), null);
  assert.equal(fanModeToGladys(null), null);
});

test('setting a fan mode writes the matching Daikin mode', () => {
  const speed = speedBlock();
  assert.equal(fanModeToDaikin(FAN_MODE.AUTO, speed), 'auto');
  assert.equal(fanModeToDaikin(FAN_MODE.LOW, speed), 'quiet');
  assert.equal(fanModeToDaikin(FAN_MODE.MEDIUM, speed), 'fixed');
});

test('HIGH is absorbed as manual rather than left to fail', () => {
  // The Gladys fan mode select always offers all five values, so the two
  // Daikin has no word for must still do something sensible.
  assert.equal(fanModeToDaikin(FAN_MODE.HIGH, speedBlock()), 'fixed');
});

test('OFF is refused: a Daikin fan has no off of its own', () => {
  assert.equal(fanModeToDaikin(FAN_MODE.OFF, speedBlock()), null);
});

test('a fan mode the unit does not offer is refused instead of guessed', () => {
  const autoOnly = speedBlock({ modes: ['auto'], fixed: null });
  assert.equal(fanModeToDaikin(FAN_MODE.LOW, autoOnly), null, 'no quiet mode');
  assert.equal(fanModeToDaikin(FAN_MODE.MEDIUM, autoOnly), null, 'no manual mode');
  assert.equal(fanModeToDaikin(FAN_MODE.AUTO, autoOnly), 'auto');
  assert.equal(fanModeToDaikin(FAN_MODE.AUTO, null), null);
});

test('a fan mode round trips through the Daikin vocabulary', () => {
  const speed = speedBlock();
  for (const mode of [FAN_MODE.AUTO, FAN_MODE.LOW, FAN_MODE.MEDIUM]) {
    const daikin = fanModeToDaikin(mode, speed);
    assert.equal(fanModeToGladys({ ...speed, currentMode: daikin }), mode);
  }
});

test('supportedFanModes reads the union over every operation mode', () => {
  const capabilities = (speedModes) => ({ speedModes, fixed: null, axes: {} });
  assert.deepEqual(supportedFanModes(capabilities(['quiet', 'auto', 'fixed'])), [
    FAN_MODE.LOW,
    FAN_MODE.MEDIUM,
    FAN_MODE.AUTO,
  ]);
  assert.deepEqual(supportedFanModes(capabilities(['auto'])), [FAN_MODE.AUTO]);
  assert.deepEqual(supportedFanModes(null), []);
});

// --- Fan level ---------------------------------------------------------------

test('the manual level is reported only while the unit runs on it', () => {
  assert.equal(fanLevelToGladys(speedBlock({ currentMode: 'fixed' })), 3);
  assert.equal(fanLevelToGladys(speedBlock({ currentMode: 'auto' })), null, 'auto is not a level');
  assert.equal(fanLevelToGladys(speedBlock({ fixed: null })), null);
  assert.equal(fanLevelToGladys(null), null);
});

test('the level needs no scaling: the feature carries the device bounds', () => {
  const speed = speedBlock();
  assert.equal(fanLevelToDaikin(1, speed), 1);
  assert.equal(fanLevelToDaikin(4, speed), 4);
  assert.equal(fanLevelToDaikin(5, speed), 5);
});

test('a level outside the device range is snapped back into it', () => {
  const speed = speedBlock({ fixed: { value: 1, min: 1, max: 3, step: 1 } });
  assert.equal(fanLevelToDaikin(9, speed), 3);
  assert.equal(fanLevelToDaikin(0, speed), 1);
  assert.equal(fanLevelToDaikin('2', speed), 2, 'the UI can send a string');
});

test('a unit without a manual level refuses one', () => {
  assert.equal(fanLevelToDaikin(3, speedBlock({ fixed: null })), null);
  assert.equal(fanLevelToDaikin(3, null), null);
});

// --- Louvers -----------------------------------------------------------------

test('the two Daikin louver axes read as one oscillation bitmap', () => {
  assert.equal(rockSettingToGladys(directionBlock()), FAN_ROCK_SETTING.OFF);
  assert.equal(
    rockSettingToGladys(
      directionBlock({ horizontal: { value: 'swing', values: ['stop', 'swing'] } }),
    ),
    FAN_ROCK_SETTING.LEFT_RIGHT,
  );
  assert.equal(
    rockSettingToGladys(
      directionBlock({ vertical: { value: 'swing', values: ['stop', 'swing'] } }),
    ),
    FAN_ROCK_SETTING.UP_DOWN,
  );
  assert.equal(
    rockSettingToGladys({
      horizontal: { value: 'swing', values: ['stop', 'swing'] },
      vertical: { value: 'swing', values: ['stop', 'swing'] },
    }),
    FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN,
  );
  assert.equal(rockSettingToGladys(null), null);
});

test('a Daikin comfort airflow does not count as oscillating', () => {
  const direction = directionBlock({
    vertical: { value: 'windNice', values: ['stop', 'swing', 'windNice'] },
  });
  assert.equal(rockSettingToGladys(direction), FAN_ROCK_SETTING.OFF);
});

test('setting the oscillation drives each axis separately', () => {
  assert.deepEqual(rockSettingToDaikin(FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN, directionBlock()), [
    { axis: 'horizontal', value: 'swing' },
    { axis: 'vertical', value: 'swing' },
  ]);
  assert.deepEqual(rockSettingToDaikin(FAN_ROCK_SETTING.UP_DOWN, directionBlock()), [
    { axis: 'horizontal', value: 'stop' },
    { axis: 'vertical', value: 'swing' },
  ]);
  assert.deepEqual(rockSettingToDaikin(FAN_ROCK_SETTING.OFF, directionBlock()), [
    { axis: 'horizontal', value: 'stop' },
    { axis: 'vertical', value: 'stop' },
  ]);
});

test('an axis the unit does not have is simply left alone', () => {
  const verticalOnly = { vertical: { value: 'stop', values: ['stop', 'swing'] } };
  assert.deepEqual(rockSettingToDaikin(FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN, verticalOnly), [
    { axis: 'vertical', value: 'swing' },
  ]);
  assert.equal(rockSettingToDaikin(FAN_ROCK_SETTING.OFF, null), null);
});

test('an axis that cannot swing at all is not written to', () => {
  const fixedVertical = {
    horizontal: { value: 'stop', values: ['stop', 'swing'] },
    vertical: { value: 'stop', values: ['stop'] },
  };
  assert.deepEqual(rockSettingToDaikin(FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN, fixedVertical), [
    { axis: 'horizontal', value: 'swing' },
  ]);
});

const axesCapabilities = (axes) => ({ speedModes: [], fixed: null, axes });

test('the oscillation bounds tell Gladys which axes exist', () => {
  assert.deepEqual(
    rockSettingBounds(
      axesCapabilities({ horizontal: ['stop', 'swing'], vertical: ['stop', 'swing'] }),
    ),
    {
      min: FAN_ROCK_SETTING.OFF,
      max: FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN,
    },
  );
  assert.deepEqual(rockSettingBounds(axesCapabilities({ horizontal: ['stop', 'swing'] })), {
    min: FAN_ROCK_SETTING.OFF,
    max: FAN_ROCK_SETTING.LEFT_RIGHT,
  });
  assert.deepEqual(rockSettingBounds(axesCapabilities({ vertical: ['stop', 'swing'] })), {
    min: FAN_ROCK_SETTING.OFF,
    max: FAN_ROCK_SETTING.UP_DOWN,
  });
});

test('a unit whose louvers cannot swing gets no oscillation feature', () => {
  assert.equal(rockSettingBounds(axesCapabilities({ vertical: ['stop'] })), null);
  assert.equal(rockSettingBounds(null), null);
});

test('supportedSwings lists the per-axis values, across every operation mode', () => {
  const capabilities = axesCapabilities({
    horizontal: ['stop', 'swing'],
    vertical: ['stop', 'swing', 'windNice'],
  });
  assert.deepEqual(supportedSwings(capabilities, 'horizontal'), [AC_SWING.OFF, AC_SWING.SWING]);
  assert.deepEqual(
    supportedSwings(capabilities, 'vertical'),
    [AC_SWING.OFF, AC_SWING.SWING],
    'windNice has no Gladys counterpart and is dropped',
  );
  assert.deepEqual(supportedSwings(axesCapabilities({ vertical: ['stop'] }), 'vertical'), []);
  assert.deepEqual(supportedSwings(null, 'horizontal'), []);
});

test('the per-axis swing maps both ways', () => {
  assert.equal(swingToGladys('stop'), AC_SWING.OFF);
  assert.equal(swingToGladys('swing'), AC_SWING.SWING);
  assert.equal(swingToGladys('windNice'), null);
  assert.equal(swingToDaikin(AC_SWING.SWING), 'swing');
  assert.equal(swingToDaikin(9), null);
});

// --- Setpoint grid -----------------------------------------------------------

test('a setpoint is snapped on the grid the unit accepts', () => {
  assert.equal(roundToStep(21.3, 18, 32, 0.5), 21.5);
  assert.equal(roundToStep(21.5, 18, 32, 0.5), 21.5);
  assert.equal(roundToStep(40, 18, 32, 0.5), 32, 'clamped to the maximum');
  assert.equal(roundToStep(5, 18, 32, 0.5), 18, 'clamped to the minimum');
  assert.equal(roundToStep(19.4, 10, 30, 1), 19, 'integer grid');
  assert.equal(roundToStep(21.5, 18, 32, 0), 21.5, 'no step declared: value kept as is');
});

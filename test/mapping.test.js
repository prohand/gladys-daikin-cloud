import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AC_FAN_SPEED,
  AC_MODE,
  AC_SWING,
  fanSpeedToDaikin,
  fanSpeedToGladys,
  modeToDaikin,
  modeToGladys,
  roundToStep,
  supportedFanSpeeds,
  swingToDaikin,
  swingToGladys,
} from '../src/mapping.js';

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

test('swing maps stop/swing and leaves the Daikin comfort airflows alone', () => {
  assert.equal(swingToGladys('stop'), AC_SWING.OFF);
  assert.equal(swingToGladys('swing'), AC_SWING.SWING);
  assert.equal(swingToGladys('windNice'), null);
  assert.equal(swingToDaikin(AC_SWING.SWING), 'swing');
  assert.equal(swingToDaikin(7), null);
});

test('the auto and quiet fan modes map directly', () => {
  assert.equal(
    fanSpeedToGladys({ currentMode: 'auto', modes: [], fixed: null }),
    AC_FAN_SPEED.AUTO,
  );
  assert.equal(
    fanSpeedToGladys({ currentMode: 'quiet', modes: [], fixed: null }),
    AC_FAN_SPEED.QUIET,
  );
  assert.equal(fanSpeedToGladys(null), null);
});

test('a 1-5 fixed fan level maps one to one on the Gladys speeds', () => {
  const speed = (value) => ({
    currentMode: 'fixed',
    modes: ['fixed'],
    fixed: { value, min: 1, max: 5, step: 1 },
  });
  assert.equal(fanSpeedToGladys(speed(1)), AC_FAN_SPEED.LOW);
  assert.equal(fanSpeedToGladys(speed(2)), AC_FAN_SPEED.LOW_MID);
  assert.equal(fanSpeedToGladys(speed(3)), AC_FAN_SPEED.MID);
  assert.equal(fanSpeedToGladys(speed(4)), AC_FAN_SPEED.MID_HIGH);
  assert.equal(fanSpeedToGladys(speed(5)), AC_FAN_SPEED.HIGH);
});

test('a narrower fixed range is spread over the Gladys speeds', () => {
  const speed = (value) => ({
    currentMode: 'fixed',
    modes: ['fixed'],
    fixed: { value, min: 1, max: 3, step: 1 },
  });
  assert.equal(fanSpeedToGladys(speed(1)), AC_FAN_SPEED.LOW);
  assert.equal(fanSpeedToGladys(speed(2)), AC_FAN_SPEED.MID);
  assert.equal(fanSpeedToGladys(speed(3)), AC_FAN_SPEED.HIGH);
});

test('a single-step fan reads as MID instead of dividing by zero', () => {
  const speed = {
    currentMode: 'fixed',
    modes: ['fixed'],
    fixed: { value: 1, min: 1, max: 1, step: 1 },
  };
  assert.equal(fanSpeedToGladys(speed), AC_FAN_SPEED.MID);
});

test('setting a fan speed picks the mode and, for fixed, the hardware level', () => {
  const speed = {
    currentMode: 'auto',
    modes: ['quiet', 'auto', 'fixed'],
    fixed: { value: 3, min: 1, max: 5, step: 1 },
  };
  assert.deepEqual(fanSpeedToDaikin(AC_FAN_SPEED.AUTO, speed), {
    currentMode: 'auto',
    fixedValue: null,
  });
  assert.deepEqual(fanSpeedToDaikin(AC_FAN_SPEED.QUIET, speed), {
    currentMode: 'quiet',
    fixedValue: null,
  });
  assert.deepEqual(fanSpeedToDaikin(AC_FAN_SPEED.LOW, speed), {
    currentMode: 'fixed',
    fixedValue: 1,
  });
  assert.deepEqual(fanSpeedToDaikin(AC_FAN_SPEED.MID, speed), {
    currentMode: 'fixed',
    fixedValue: 3,
  });
  assert.deepEqual(fanSpeedToDaikin(AC_FAN_SPEED.HIGH, speed), {
    currentMode: 'fixed',
    fixedValue: 5,
  });
});

test('a fan speed round trips through the Daikin vocabulary', () => {
  const speed = {
    currentMode: 'auto',
    modes: ['quiet', 'auto', 'fixed'],
    fixed: { value: 3, min: 1, max: 9, step: 2 },
  };
  for (const requested of [AC_FAN_SPEED.LOW, AC_FAN_SPEED.MID, AC_FAN_SPEED.HIGH]) {
    const target = fanSpeedToDaikin(requested, speed);
    const readBack = fanSpeedToGladys({
      ...speed,
      currentMode: 'fixed',
      fixed: { ...speed.fixed, value: target.fixedValue },
    });
    assert.equal(readBack, requested, `speed ${requested} must survive the round trip`);
  }
});

test('TURBO falls back to the fastest fixed speed Daikin offers', () => {
  const speed = {
    currentMode: 'auto',
    modes: ['auto', 'fixed'],
    fixed: { value: 1, min: 1, max: 5, step: 1 },
  };
  assert.deepEqual(fanSpeedToDaikin(AC_FAN_SPEED.TURBO, speed), {
    currentMode: 'fixed',
    fixedValue: 5,
  });
});

test('a mode the unit does not offer is refused instead of guessed', () => {
  const autoOnly = { currentMode: 'auto', modes: ['auto'], fixed: null };
  assert.equal(fanSpeedToDaikin(AC_FAN_SPEED.QUIET, autoOnly), null);
  assert.equal(fanSpeedToDaikin(AC_FAN_SPEED.MID, autoOnly), null);
  assert.equal(fanSpeedToDaikin(AC_FAN_SPEED.AUTO, null), null);
});

test('supportedFanSpeeds lists only what the unit can reach', () => {
  assert.deepEqual(supportedFanSpeeds({ currentMode: 'auto', modes: ['auto'], fixed: null }), [
    AC_FAN_SPEED.AUTO,
  ]);
  assert.deepEqual(
    supportedFanSpeeds({
      currentMode: 'fixed',
      modes: ['quiet', 'auto', 'fixed'],
      fixed: { value: 1, min: 1, max: 5, step: 1 },
    }),
    [
      AC_FAN_SPEED.AUTO,
      AC_FAN_SPEED.LOW,
      AC_FAN_SPEED.LOW_MID,
      AC_FAN_SPEED.MID,
      AC_FAN_SPEED.MID_HIGH,
      AC_FAN_SPEED.HIGH,
      AC_FAN_SPEED.QUIET,
    ],
  );
  assert.deepEqual(supportedFanSpeeds(null), []);
});

test('a setpoint is snapped on the grid the unit accepts', () => {
  assert.equal(roundToStep(21.3, 18, 32, 0.5), 21.5);
  assert.equal(roundToStep(21.5, 18, 32, 0.5), 21.5);
  assert.equal(roundToStep(40, 18, 32, 0.5), 32, 'clamped to the maximum');
  assert.equal(roundToStep(5, 18, 32, 0.5), 18, 'clamped to the minimum');
  assert.equal(roundToStep(19.4, 10, 30, 1), 19, 'integer grid');
  assert.equal(roundToStep(21.5, 18, 32, 0), 21.5, 'no step declared: value kept as is');
});

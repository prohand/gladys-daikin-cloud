import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from '../src/daikin/model.js';
import { FEATURE, buildCommands } from '../src/devices/index.js';
import { AC_MODE, FAN_ROCK_SETTING } from '../src/mapping.js';
import { DaikinStore } from '../src/store.js';
import { CONTROL, controlButtons, resolveControl } from '../src/widgetControls.js';
import { HEAT_PUMP_UNIT, SPLIT_UNIT } from './fixtures/gatewayDevices.js';

const unitOf = (payload) => parseUnits([structuredClone(payload)])[0];
const keysOf = (buttons) => buttons.map((button) => button.action.key);
const labelsOf = (buttons) => buttons.map((button) => button.label.fr);
const store = new DaikinStore({ api: {} });

// What index.js does with a tap: resolve it, then send it through the same
// commands and optimistic patch as the dashboard.
const tap = (unit, actionKey, params, capabilities) => {
  const control = resolveControl(unit, actionKey, params, capabilities);
  if (control.command) {
    const { writes } = buildCommands(unit, control.command.featureKey, control.command.value);
    store.applyWrites(unit, writes);
  }
  return control;
};

test('every setting fits in four buttons, each doing one thing', () => {
  const unit = unitOf(SPLIT_UNIT);
  assert.deepEqual(keysOf(controlButtons(unit, CONTROL.POWER)), ['power']);
  assert.deepEqual(keysOf(controlButtons(unit, CONTROL.SETPOINT)), [
    'setpoint_down',
    'setpoint_up',
  ]);
  assert.deepEqual(keysOf(controlButtons(unit, CONTROL.FAN)), ['fan_down', 'fan_up']);
  assert.deepEqual(keysOf(controlButtons(unit, CONTROL.SWING)), [
    'swing_horizontal',
    'swing_vertical',
  ]);
  for (const control of Object.values(CONTROL)) {
    assert.ok(controlButtons(unit, control).length <= 4, `${control}: the core keeps four buttons`);
  }
});

test('the mode buttons are the modes the unit can switch to', () => {
  const unit = unitOf(SPLIT_UNIT);
  // Cooling runs: it gets no button, the four others do.
  const buttons = controlButtons(unit, CONTROL.MODE);
  assert.deepEqual(labelsOf(buttons), ['Auto', 'Déshumidification', 'Chauffage', 'Ventilation']);
  assert.deepEqual(keysOf(buttons), ['mode_auto', 'mode_dry', 'mode_heating', 'mode_fan_only']);
  assert.deepEqual(tap(unit, 'mode_heating', { mode: 'heating' }).command, {
    featureKey: FEATURE.MODE,
    value: AC_MODE.HEATING,
  });
  assert.equal(unit.setpoint.value, 21, 'the setpoint buttons now drive the heating setpoint');
  assert.ok(labelsOf(controlButtons(unit, CONTROL.MODE)).includes('Froid'));
  assert.throws(() => resolveControl(unit, 'mode_x', { mode: 'humidification' }));
});

test('a setting the unit cannot use in its current mode has no button', () => {
  const unit = unitOf(SPLIT_UNIT);
  tap(unit, 'mode_dry', { mode: 'dry' });
  // Drying has no setpoint, no manual fan level and no louvers here.
  for (const control of [CONTROL.SETPOINT, CONTROL.FAN, CONTROL.SWING]) {
    assert.deepEqual(controlButtons(unit, control), [], control);
  }
});

test('two taps on "+" raise the setpoint twice, and the limit sends nothing', () => {
  const unit = unitOf(SPLIT_UNIT);
  assert.deepEqual(tap(unit, 'setpoint_up').command, {
    featureKey: FEATURE.TARGET_TEMPERATURE,
    value: 22.5,
  });
  assert.equal(tap(unit, 'setpoint_up').command.value, 23);
  unit.setpoint.value = unit.setpoint.max;
  assert.match(tap(unit, 'setpoint_up').message.fr, /limite/);
});

test('the fan steps from the current level, and leaves auto on the first tap', () => {
  const unit = unitOf(SPLIT_UNIT);
  assert.deepEqual(tap(unit, 'fan_down').command, { featureKey: FEATURE.FAN_LEVEL, value: 2 });
  unit.fan.current.speed.currentMode = 'auto';
  unit.fan.current.speed.fixed.value = unit.fan.current.speed.fixed.max;
  assert.deepEqual(tap(unit, 'fan_up').command, { featureKey: FEATURE.FAN_LEVEL, value: 5 });
  assert.ok(tap(unit, 'fan_up').message, 'now on the top manual level: nothing to send');
});

test('the louvers use one feature per axis, or the bitmap on an older catalog', () => {
  const unit = unitOf(SPLIT_UNIT);
  assert.deepEqual(labelsOf(controlButtons(unit, CONTROL.SWING)), [
    'Balayer gauche/droite',
    'Figer haut/bas',
  ]);
  assert.deepEqual(resolveControl(unit, 'swing_horizontal', { on: true }).command, {
    featureKey: FEATURE.SWING_HORIZONTAL,
    value: 1,
  });
  // The vertical axis keeps swinging while the horizontal one starts.
  const fallback = resolveControl(
    unit,
    'swing_horizontal',
    { on: true },
    { fanCategory: true, acSwing: false },
  );
  assert.deepEqual(fallback.command, {
    featureKey: FEATURE.FAN_ROCK,
    value: FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN,
  });
});

test('the comfort buttons follow each mode, read-only ones get none', () => {
  const unit = unitOf(SPLIT_UNIT);
  const buttons = controlButtons(unit, CONTROL.COMFORT);
  // "Keep dry" is read-only on this unit: no button pretends to drive it.
  assert.deepEqual(labelsOf(buttons), ['Activer Powerful', 'Activer Econo', 'Couper Streamer']);
  tap(unit, buttons[0].action.key, buttons[0].action.params);
  assert.equal(unit.toggles.powerful.on, true);
  assert.equal(controlButtons(unit, CONTROL.COMFORT)[0].label.fr, 'Couper Powerful');
});

test('the on/off button says what it will do', () => {
  const unit = unitOf(SPLIT_UNIT);
  assert.equal(controlButtons(unit, CONTROL.POWER)[0].label.fr, 'Éteindre');
  tap(unit, 'power', { on: false });
  assert.equal(unit.power, 'off');
  assert.equal(controlButtons(unit, CONTROL.POWER)[0].label.fr, 'Allumer');
});

test('a unit without setpoint or fan still gets its modes', () => {
  const unit = unitOf(HEAT_PUMP_UNIT);
  assert.deepEqual(labelsOf(controlButtons(unit, CONTROL.MODE)), ['Froid', 'Auto']);
  assert.deepEqual(controlButtons(unit, CONTROL.SETPOINT), []);
  assert.throws(() => resolveControl(unit, 'setpoint_up'), /setpoint/);
  assert.throws(() => resolveControl(unit, 'unknown_action'), /Unknown/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from '../src/daikin/model.js';
import { FEATURE, buildCommands } from '../src/devices/index.js';
import { AC_MODE, FAN_ROCK_SETTING } from '../src/mapping.js';
import { DaikinStore } from '../src/store.js';
import { CONTROL_PAGE, controlPanel, controlPages, resolveControl } from '../src/widgetControls.js';
import { HEAT_PUMP_UNIT, SPLIT_UNIT } from './fixtures/gatewayDevices.js';

const controlButtons = (...args) => controlPanel(...args).buttons;
const unitOf = (payload) => parseUnits([structuredClone(payload)])[0];
const keysOf = (buttons) => buttons.map((button) => button.action.key);
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

test('a split unit gets a page per setting, comfort modes two by two', () => {
  const pages = controlPages(unitOf(SPLIT_UNIT));
  assert.deepEqual(
    pages.map((page) => page.key),
    [
      CONTROL_PAGE.SETPOINT,
      CONTROL_PAGE.MODE,
      CONTROL_PAGE.FAN,
      CONTROL_PAGE.SWING,
      CONTROL_PAGE.COMFORT,
      `${CONTROL_PAGE.COMFORT}_2`,
    ],
  );
  // "Keep dry" is read-only on this unit: no button pretends to drive it.
  const comfort = pages
    .flatMap((page) => keysOf(page.buttons))
    .filter((key) => key.startsWith('toggle_'));
  assert.deepEqual(comfort, ['toggle_powerful', 'toggle_econo', 'toggle_streamer']);
});

test('every page shows its buttons, the on/off and the way to the next page', () => {
  const unit = unitOf(SPLIT_UNIT);
  const first = controlButtons(unit, undefined);
  assert.deepEqual(keysOf(first), ['setpoint_down', 'setpoint_up', 'power', 'next_page']);
  assert.deepEqual(first[2].action.params, { on: false }, 'the unit runs: the button turns it off');
  assert.equal(first[3].label.fr, 'Suivant : Mode');

  const mode = controlButtons(unit, CONTROL_PAGE.MODE);
  // Cooling sits between Drying and Heating in the order Daikin lists them.
  assert.deepEqual(
    mode.slice(0, 2).map((button) => button.action.params.mode),
    ['dry', 'heating'],
  );

  const last = controlButtons(unit, `${CONTROL_PAGE.COMFORT}_2`);
  assert.equal(last.at(-1).action.params.page, CONTROL_PAGE.SETPOINT, 'the last page loops back');
  for (const page of controlPages(unit)) {
    assert.ok(controlButtons(unit, page.key).length <= 4, 'the core keeps four buttons');
  }
});

test('a page the unit no longer offers falls back to the first one', () => {
  const unit = unitOf(SPLIT_UNIT);
  tap(unit, 'mode_previous', { mode: 'dry' });
  // Drying has no setpoint, no manual fan level and no louvers here.
  assert.deepEqual(
    controlPages(unit).map((page) => page.key),
    [CONTROL_PAGE.MODE, CONTROL_PAGE.COMFORT, `${CONTROL_PAGE.COMFORT}_2`],
  );
  assert.deepEqual(controlButtons(unit, CONTROL_PAGE.FAN), controlButtons(unit, undefined));
  assert.equal(controlButtons(unit, CONTROL_PAGE.FAN)[0].action.key, 'mode_previous');
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

test('the mode buttons send the mode they name', () => {
  const unit = unitOf(SPLIT_UNIT);
  assert.deepEqual(tap(unit, 'mode_next', { mode: 'heating' }).command, {
    featureKey: FEATURE.MODE,
    value: AC_MODE.HEATING,
  });
  assert.equal(unit.setpoint.value, 21, 'the setpoint page now drives the heating setpoint');
  assert.throws(() => resolveControl(unit, 'mode_next', { mode: 'humidification' }));
});

test('the louvers use one feature per axis, or the bitmap on an older catalog', () => {
  const unit = unitOf(SPLIT_UNIT);
  const [horizontal, vertical] = controlButtons(unit, CONTROL_PAGE.SWING);
  assert.equal(horizontal.label.fr, 'Balayer gauche/droite');
  assert.equal(vertical.label.fr, 'Figer haut/bas');
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

test('Powerful and the on/off follow what the button says', () => {
  const unit = unitOf(SPLIT_UNIT);
  const [powerful] = controlButtons(unit, CONTROL_PAGE.COMFORT);
  assert.equal(powerful.label.fr, 'Activer Powerful');
  tap(unit, powerful.action.key, powerful.action.params);
  assert.equal(unit.toggles.powerful.on, true);
  assert.equal(controlButtons(unit, CONTROL_PAGE.COMFORT)[0].label.fr, 'Couper Powerful');

  tap(unit, 'power', { on: false });
  assert.equal(unit.power, 'off');
  assert.equal(controlButtons(unit, undefined)[2].label.fr, 'Allumer');
});

test('a unit without setpoint or fan still gets its modes', () => {
  const unit = unitOf(HEAT_PUMP_UNIT);
  assert.deepEqual(
    controlPages(unit).map((page) => page.key),
    [CONTROL_PAGE.MODE],
  );
  assert.throws(() => resolveControl(unit, 'setpoint_up'), /setpoint/);
  assert.throws(() => resolveControl(unit, 'unknown_action'), /Unknown/);
});

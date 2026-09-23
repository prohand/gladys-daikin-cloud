import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { parseUnits } from '../src/daikin/model.js';
import { FEATURE, featureExternalId } from '../src/devices/index.js';
import { CONTROL } from '../src/widgetControls.js';
import {
  UNIT_CHART,
  buildAccountWidget,
  buildControlsWidget,
  buildUnitWidget,
} from '../src/widgets.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  ALL_DEVICES,
  HEAT_PUMP_UNIT,
  OFFLINE_UNIT,
  SPLIT_UNIT,
} from './fixtures/gatewayDevices.js';

const gladys = createFakeGladys();
const NOW = new Date(2026, 7, 15, 13, 30);
const unitOf = (payload) => parseUnits([structuredClone(payload)])[0];
const ofType = (content, type) => content.components.filter((component) => component.type === type);

// The SDK ships the core's own checks: an empty list means the content is
// rendered exactly as sent — nothing dropped by the budget, nothing truncated.
const assertRenderedAsSent = (content) => assert.deepEqual(validateWidgetContent(content), []);

test('the unit widget fits the vocabulary for every unit shape and every chart', () => {
  for (const payload of [SPLIT_UNIT, OFFLINE_UNIT, HEAT_PUMP_UNIT]) {
    for (const chart of Object.values(UNIT_CHART)) {
      assertRenderedAsSent(buildUnitWidget(gladys, unitOf(payload), { chart, now: NOW }));
    }
  }
});

test('the unit tiles are live bindings to the device features', () => {
  const unit = unitOf(SPLIT_UNIT);
  const content = buildUnitWidget(gladys, unit, { now: NOW });
  const bound = ofType(content, 'value').map((tile) => tile.device_feature);
  assert.deepEqual(bound, [
    featureExternalId(gladys, unit, FEATURE.ROOM_TEMPERATURE),
    featureExternalId(gladys, unit, FEATURE.TARGET_TEMPERATURE),
    featureExternalId(gladys, unit, FEATURE.OUTDOOR_TEMPERATURE),
    featureExternalId(gladys, unit, FEATURE.ENERGY_TODAY),
  ]);
  const buttons = ofType(content, 'button');
  assert.deepEqual(
    buttons.map((button) => [button.device_feature, button.value]),
    [
      [featureExternalId(gladys, unit, FEATURE.POWER), 1],
      [featureExternalId(gladys, unit, FEATURE.POWER), 0],
    ],
  );
});

test('an unreachable unit gets no buttons, and says why its values are old', () => {
  const content = buildUnitWidget(gladys, unitOf(OFFLINE_UNIT), { now: NOW });
  assert.equal(ofType(content, 'button').length, 0);
  assert.match(ofType(content, 'text')[0].text.en, /Unreachable/);
  const state = ofType(content, 'status')[0].items[0];
  assert.equal(state.color, 'danger');
});

test('the consumption chart puts yesterday next to today, without the hours to come', () => {
  const content = buildUnitWidget(gladys, unitOf(SPLIT_UNIT), {
    chart: UNIT_CHART.CONSUMPTION,
    now: NOW,
  });
  const [chart] = ofType(content, 'chart');
  const [today, yesterday] = chart.series;
  // 13:30: the slots starting at 0, 2, ... 12 h are measured, 14 h is not yet.
  assert.equal(today.points.length, 7);
  assert.equal(yesterday.points.length, 12);
  assert.equal(today.points[0].t, yesterday.points[0].t, 'same hours, side by side');
  assert.equal(today.points[0].v, 0.15);
  assert.equal(yesterday.points[0].v, 0.8);
});

test('a unit with nothing to chart simply has no chart', () => {
  const content = buildUnitWidget(gladys, unitOf(HEAT_PUMP_UNIT), {
    chart: UNIT_CHART.CONSUMPTION,
    now: NOW,
  });
  assert.equal(ofType(content, 'chart').length, 0);
});

test('a unit missing from the snapshot gets a message, not an error', () => {
  const waiting = buildUnitWidget(gladys, undefined, { ready: false });
  assert.match(waiting.components[0].text.en, /Reading/);
  assert.equal(waiting.ttl_seconds, 30, 'retry soon: the first read is on its way');
  const gone = buildUnitWidget(gladys, undefined, { ready: true });
  assert.match(gone.components[0].text.en, /no longer/);
  assertRenderedAsSent(waiting);
  assertRenderedAsSent(gone);
});

test('the controls widget fits the vocabulary for every unit and every setting', () => {
  for (const payload of [SPLIT_UNIT, OFFLINE_UNIT, HEAT_PUMP_UNIT]) {
    for (const control of Object.values(CONTROL)) {
      assertRenderedAsSent(buildControlsWidget(gladys, unitOf(payload), { control }));
    }
  }
  assertRenderedAsSent(buildControlsWidget(gladys, undefined, { ready: false }));
});

test('the controls widget holds its buttons and nothing else', () => {
  const content = buildControlsWidget(gladys, unitOf(SPLIT_UNIT), { control: CONTROL.SETPOINT });
  assert.deepEqual(
    content.components.map((component) => component.type),
    ['button', 'button'],
  );
});

test('a setting with no button, or an unreachable unit, gets a message', () => {
  const heatPump = buildControlsWidget(gladys, unitOf(HEAT_PUMP_UNIT), { control: CONTROL.FAN });
  assert.match(heatPump.components[0].text.fr, /Indisponible/);
  const offline = buildControlsWidget(gladys, unitOf(OFFLINE_UNIT), { control: CONTROL.MODE });
  assert.equal(ofType(offline, 'button').length, 0);
  assert.match(offline.components[0].text.en, /Unreachable/);
});

test('the account widget sums the account and shows the quota', () => {
  const units = parseUnits(structuredClone(ALL_DEVICES));
  const content = buildAccountWidget(units, {
    rateLimits: { remainingDay: 15, limitDay: 200 },
    lastRefreshAt: NOW.getTime() - 5 * 60_000,
    now: NOW,
  });
  assertRenderedAsSent(content);

  const running = units.filter((unit) => unit.online && unit.power === 'on').length;
  assert.equal(ofType(content, 'value')[0].value, `${running}/3`);
  assert.equal(ofType(content, 'value')[1].value, 1.8);
  const [gauge] = ofType(content, 'gauge');
  assert.deepEqual([gauge.value, gauge.max, gauge.color], [15, 200, 'warning']);
  assert.match(ofType(content, 'text')[0].text.fr, /il y a 5 min/);
  assert.equal(ofType(content, 'status')[0].items.length, 3, 'one row per unit');

  const [chart] = ofType(content, 'chart');
  assert.deepEqual(
    chart.series.map((series) => [series.name, series.points.length]),
    [
      ['2026', 8],
      ['2025', 12],
    ],
  );
});

test('the account rows speak the language and the unit system of the user', () => {
  const unit = unitOf(SPLIT_UNIT);
  unit.roomTemperature = 22.5;
  const metric = buildAccountWidget([unit], { now: NOW });
  assert.deepEqual(ofType(metric, 'status')[0].items[0].value, {
    en: 'Cooling · 22.5 °C',
    fr: 'Froid · 22,5 °C',
  });
  const us = buildAccountWidget([unit], { unitSystem: 'us', now: NOW });
  assert.equal(ofType(us, 'status')[0].items[0].value.en, 'Cooling · 72.5 °F');
});

test('the account widget explains an empty or unlinked account', () => {
  for (const content of [
    buildAccountWidget([], { linked: false }),
    buildAccountWidget([], { ready: false }),
    buildAccountWidget([]),
  ]) {
    assertRenderedAsSent(content);
    assert.equal(content.components[0].type, 'text');
  }
});

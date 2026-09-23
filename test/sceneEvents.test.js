import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from '../src/daikin/model.js';
import { QUOTA_LOW_THRESHOLD, SCENE_TRIGGER, SceneEventTracker } from '../src/sceneEvents.js';
import { ALL_DEVICES } from './fixtures/gatewayDevices.js';

const describe = (unit) => ({ unit: `device:${unit.platformId}`, unit_name: unit.name });
const read = () => parseUnits(structuredClone(ALL_DEVICES));

test('the first read only sets the baseline: a restart announces nothing', () => {
  const tracker = new SceneEventTracker();
  // The fixture account holds an offline unit in error: still no event.
  assert.deepEqual(tracker.unitsRead(read(), describe), []);
  assert.deepEqual(tracker.unitsRead(read(), describe), [], 'nothing changed');
});

test('a unit dropping off the cloud and coming back fires one event each way', () => {
  const tracker = new SceneEventTracker();
  tracker.unitsRead(read(), describe);

  const lost = read();
  lost[0].online = false;
  assert.deepEqual(tracker.unitsRead(lost, describe), [
    {
      key: SCENE_TRIGGER.UNIT_CONNECTION,
      data: { ...describe(lost[0]), connection: 'offline' },
    },
  ]);
  assert.deepEqual(tracker.unitsRead(lost, describe), [], 'once per transition');

  const back = read();
  assert.deepEqual(tracker.unitsRead(back, describe), [
    {
      key: SCENE_TRIGGER.UNIT_CONNECTION,
      data: { ...describe(back[0]), connection: 'online' },
    },
  ]);
});

test('a fault is reported, then cleared, while the unit is reachable', () => {
  const tracker = new SceneEventTracker();
  tracker.unitsRead(read(), describe);

  const faulty = read();
  faulty[0].inErrorState = true;
  assert.deepEqual(tracker.unitsRead(faulty, describe), [
    { key: SCENE_TRIGGER.UNIT_ERROR, data: { ...describe(faulty[0]), state: 'error' } },
  ]);
  const fixed = read();
  assert.deepEqual(tracker.unitsRead(fixed, describe), [
    { key: SCENE_TRIGGER.UNIT_ERROR, data: { ...describe(fixed[0]), state: 'ok' } },
  ]);
});

test('the fault flag of an unreachable unit is never compared', () => {
  // Daikin keeps the last flag of a unit it cannot reach: a change there says
  // nothing about the unit, only about what the cloud remembers.
  const tracker = new SceneEventTracker();
  tracker.unitsRead(read(), describe);
  const offlineIndex = read().findIndex((unit) => !unit.online);
  const changed = read();
  changed[offlineIndex].inErrorState = !changed[offlineIndex].inErrorState;
  assert.deepEqual(tracker.unitsRead(changed, describe), []);
});

test('a unit new to the account starts silently', () => {
  const tracker = new SceneEventTracker();
  tracker.unitsRead(read().slice(0, 1), describe);
  assert.deepEqual(tracker.unitsRead(read(), describe), []);
});

test('the quota fires once on the way down, and re-arms when the day resets', () => {
  const tracker = new SceneEventTracker();
  const quota = (remainingDay) => tracker.quotaRead({ remainingDay, limitDay: 200 });
  assert.deepEqual(quota(null), [], 'no header, no opinion');
  assert.deepEqual(quota(QUOTA_LOW_THRESHOLD - 5), [], 'already low at start: baseline only');
  assert.deepEqual(quota(150), []);
  assert.deepEqual(quota(QUOTA_LOW_THRESHOLD + 1), []);
  assert.deepEqual(quota(QUOTA_LOW_THRESHOLD), [
    { key: SCENE_TRIGGER.QUOTA_LOW, data: { remaining: QUOTA_LOW_THRESHOLD, limit: 200 } },
  ]);
  assert.deepEqual(quota(3), [], 'still low: no second event');
  assert.deepEqual(quota(199), [], 'the daily reset');
  assert.equal(quota(0).length, 1, 'low again the next day');
});

test('an expired session fires once, and again only after a good read', () => {
  const tracker = new SceneEventTracker();
  const authError = Object.assign(new Error('401'), { isAuthError: true });
  assert.deepEqual(tracker.refreshFailed(authError), [
    { key: SCENE_TRIGGER.SESSION_EXPIRED, data: {} },
  ]);
  assert.deepEqual(tracker.refreshFailed(authError), []);
  assert.deepEqual(tracker.refreshFailed(new Error('network')), [], 'not an auth error');
  tracker.unitsRead(read(), describe);
  assert.equal(tracker.refreshFailed(authError).length, 1);
});

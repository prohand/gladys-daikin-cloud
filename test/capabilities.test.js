import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_LEVELS,
  detectSupportedOptions,
  isAtLeast,
  publishWithBestCatalog,
} from '../src/capabilities.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

/**
 * A Gladys that refuses every catalog richer than the one it knows, the way
 * the core rejects an unknown feature type.
 * @param {string} accepts the richest level this fake Gladys understands
 * @returns {{ gladys: object, attempts: Array<string> }} the fake and its log
 */
function createPickyGladys(accepts) {
  const attempts = [];
  const order = CAPABILITY_LEVELS.map((entry) => entry.level);
  return {
    attempts,
    gladys: {
      async publishDiscoveredDevices(devices) {
        const level = devices[0].level;
        attempts.push(level);
        if (order.indexOf(level) < order.indexOf(accepts)) {
          throw new Error(`devices[0].features[0].type: unknown type`);
        }
        return { success: true, count: devices.length };
      },
    },
  };
}

const buildDevices = (capabilities) => [{ level: capabilities.level }];

test('the richest catalog Gladys accepts is the one that is used', async () => {
  const { gladys, attempts } = createPickyGladys('full');
  const capabilities = await publishWithBestCatalog(gladys, buildDevices, true);
  assert.deepEqual(attempts, ['full'], 'a modern Gladys takes it on the first try');
  assert.equal(capabilities.level, 'full');
  assert.equal(capabilities.acSwing, true);
  assert.equal(capabilities.supportedOptions, true);
});

test('a Gladys without the per-axis airflow falls back one level', async () => {
  const { gladys, attempts } = createPickyGladys('fan');
  const capabilities = await publishWithBestCatalog(gladys, buildDevices, false);
  assert.deepEqual(attempts, ['full', 'fan']);
  assert.equal(capabilities.level, 'fan');
  assert.equal(capabilities.fanCategory, true);
  assert.equal(capabilities.acSwing, false);
});

test('a Gladys without the fan category keeps the energy monitoring', async () => {
  // The 30-minute consumption pair landed BEFORE the fan category: dropping it
  // along with the fan would cost an instance something it does support.
  const { gladys, attempts } = createPickyGladys('energy');
  const capabilities = await publishWithBestCatalog(gladys, buildDevices, false);
  assert.deepEqual(attempts, ['full', 'fan', 'energy']);
  assert.equal(capabilities.fanCategory, false);
  assert.equal(capabilities.energyMonitoring, true);
});

test('a Gladys older than the energy monitoring falls back to the base catalog', async () => {
  const { gladys, attempts } = createPickyGladys('base');
  const capabilities = await publishWithBestCatalog(gladys, buildDevices, false);
  assert.deepEqual(attempts, ['full', 'fan', 'energy', 'base']);
  assert.equal(capabilities.fanCategory, false);
  assert.equal(capabilities.energyMonitoring, false);
});

test('a Gladys refusing even the base catalog surfaces the error', async () => {
  // That is a bug in the payload, not an old Gladys: swallowing it would hide
  // a broken integration behind an empty device list.
  const gladys = {
    async publishDiscoveredDevices() {
      throw new Error('devices[0].name: must be a non-empty string');
    },
  };
  await assert.rejects(
    () => publishWithBestCatalog(gladys, buildDevices, false),
    /must be a non-empty string/,
  );
});

test('the fallback never depends on reading a version', async () => {
  // The whole point of the redesign: a Gladys whose version cannot be read
  // still gets the full catalog, because only Gladys decides what it accepts.
  const { gladys, attempts } = createPickyGladys('full');
  const capabilities = await publishWithBestCatalog(gladys, buildDevices, false);
  assert.equal(capabilities.fanCategory, true);
  assert.equal(capabilities.acSwing, true);
  assert.deepEqual(attempts, ['full']);
});

test('supported_options are only sent to a Gladys known to store them', async () => {
  assert.equal(await detectSupportedOptions(createFakeGladys({ gladysVersion: '4.84.3' })), true);
  assert.equal(await detectSupportedOptions(createFakeGladys({ gladysVersion: '4.84.2' })), false);
  assert.equal(await detectSupportedOptions(createFakeGladys({ gladysVersion: '5.0.0' })), true);
});

test('an unreadable version costs an unrestricted dropdown, nothing more', async () => {
  assert.equal(await detectSupportedOptions(createFakeGladys({ gladysVersion: 'nightly' })), false);
  const failing = {
    async getStatus() {
      throw new Error('websocket closed');
    },
  };
  assert.equal(await detectSupportedOptions(failing), false);
});

test('versions compare numerically, not as strings', () => {
  assert.equal(isAtLeast('4.9.0', [4, 84, 3]), false, '4.9 < 4.84');
  assert.equal(isAtLeast('4.85.0', [4, 84, 3]), true);
  assert.equal(isAtLeast('4.85.0-beta.1', [4, 84, 3]), true, 'a pre-release counts as its base');
  assert.equal(isAtLeast('4.84', [4, 84, 3]), false, 'a truncated version is not trusted');
  assert.equal(isAtLeast(undefined, [4, 84, 3]), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPABILITIES,
  capabilitiesForVersion,
  detectCapabilities,
  isAtLeast,
} from '../src/capabilities.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

test('the fan features need the FAN category, added in Gladys 4.79.0', () => {
  assert.equal(capabilitiesForVersion('4.79.0').fanCategory, true);
  assert.equal(capabilitiesForVersion('4.84.3').fanCategory, true);
  assert.equal(capabilitiesForVersion('5.0.0').fanCategory, true);
  assert.equal(capabilitiesForVersion('4.78.2').fanCategory, false);
  assert.equal(capabilitiesForVersion('4.62.0').fanCategory, false);
  assert.equal(
    capabilitiesForVersion('4.9.0').fanCategory,
    false,
    '4.9 < 4.79, not a string compare',
  );
});

test('restricting a mode list needs supported_options, added in Gladys 4.84.3', () => {
  assert.equal(capabilitiesForVersion('4.84.3').supportedOptions, true);
  assert.equal(capabilitiesForVersion('4.84.2').supportedOptions, false);
  assert.equal(capabilitiesForVersion('4.79.0').supportedOptions, false);
});

test('an unreadable version falls back to the base catalog', () => {
  assert.deepEqual(capabilitiesForVersion(undefined), DEFAULT_CAPABILITIES);
  assert.deepEqual(capabilitiesForVersion('unknown'), DEFAULT_CAPABILITIES);
  assert.equal(isAtLeast('4.84', [4, 79, 0]), false, 'a truncated version is not trusted');
});

test('a pre-release counts as its base version', () => {
  assert.equal(isAtLeast('4.85.0-beta.1', [4, 79, 0]), true);
});

test('the capabilities are read from the connected Gladys', async () => {
  assert.deepEqual(await detectCapabilities(createFakeGladys({ gladysVersion: '4.84.3' })), {
    fanCategory: true,
    supportedOptions: true,
    acSwing: true,
  });
  assert.deepEqual(await detectCapabilities(createFakeGladys({ gladysVersion: '4.80.0' })), {
    fanCategory: true,
    supportedOptions: false,
    acSwing: false,
  });
  assert.deepEqual(await detectCapabilities(createFakeGladys({ gladysVersion: '4.70.0' })), {
    fanCategory: false,
    supportedOptions: false,
    acSwing: false,
  });
});

test('a failing getStatus never stops the integration', async () => {
  const gladys = {
    async getStatus() {
      throw new Error('websocket closed');
    },
  };
  assert.deepEqual(await detectCapabilities(gladys), DEFAULT_CAPABILITIES);
});

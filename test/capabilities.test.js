import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPABILITIES,
  capabilitiesForVersion,
  detectCapabilities,
  isAtLeast,
} from '../src/capabilities.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

test('the fan and swing features need Gladys 4.84.3', () => {
  assert.equal(capabilitiesForVersion('4.84.3').fanAndSwing, true);
  assert.equal(capabilitiesForVersion('4.84.4').fanAndSwing, true);
  assert.equal(capabilitiesForVersion('4.85.0').fanAndSwing, true);
  assert.equal(capabilitiesForVersion('5.0.0').fanAndSwing, true);
  assert.equal(capabilitiesForVersion('4.84.2').fanAndSwing, false);
  assert.equal(capabilitiesForVersion('4.62.0').fanAndSwing, false);
  assert.equal(
    capabilitiesForVersion('4.9.0').fanAndSwing,
    false,
    '4.9 < 4.84, not a string comparison',
  );
});

test('an unreadable version falls back to the base catalog', () => {
  assert.equal(capabilitiesForVersion(undefined).fanAndSwing, false);
  assert.equal(capabilitiesForVersion('unknown').fanAndSwing, false);
  assert.equal(isAtLeast('4.84', [4, 84, 3]), false, 'a truncated version is not trusted');
});

test('a pre-release counts as its base version', () => {
  assert.equal(isAtLeast('4.85.0-beta.1', [4, 84, 3]), true);
});

test('the capabilities are read from the connected Gladys', async () => {
  assert.deepEqual(await detectCapabilities(createFakeGladys({ gladysVersion: '4.84.3' })), {
    fanAndSwing: true,
  });
  assert.deepEqual(await detectCapabilities(createFakeGladys({ gladysVersion: '4.70.0' })), {
    fanAndSwing: false,
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

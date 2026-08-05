import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  MAX_POLL_FREQUENCY,
  MIN_POLL_FREQUENCY,
  clampPollFrequency,
  hasCredentials,
  hasStoredTokens,
  normalizeConfig,
  readTokens,
  tokensToConfig,
} from '../src/config.js';

test('an empty config falls back to the defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(config.client_id, '');
  assert.equal(config.client_secret, '');
});

test('values coming from the form as strings are coerced and trimmed', () => {
  const config = normalizeConfig({
    poll_frequency: '1800',
    client_id: '  abc  ',
    client_secret: 'shh ',
  });
  assert.equal(config.poll_frequency, 1800);
  assert.equal(config.client_id, 'abc');
  assert.equal(config.client_secret, 'shh');
});

test('the refresh interval stays inside what the Daikin quota allows', () => {
  assert.equal(clampPollFrequency(30), MIN_POLL_FREQUENCY);
  assert.equal(clampPollFrequency(99999), MAX_POLL_FREQUENCY);
  assert.equal(clampPollFrequency(Number.NaN), DEFAULT_CONFIG.poll_frequency);
  assert.equal(clampPollFrequency(901.4), 901);
});

test('the credentials are only complete when both fields are filled in', () => {
  assert.equal(hasCredentials(normalizeConfig({ client_id: 'a', client_secret: 'b' })), true);
  assert.equal(hasCredentials(normalizeConfig({ client_id: 'a' })), false);
  assert.equal(hasCredentials(normalizeConfig()), false);
});

test('the OAuth session round trips through the off-schema config keys', () => {
  const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1234 };
  const stored = tokensToConfig(tokens);
  assert.deepEqual(readTokens(stored), tokens);
});

test('a payload is only read as a session when it actually carries one', () => {
  // A form save that only sends the schema fields must never be mistaken for
  // "the user unlinked their account": the live session has to survive it.
  assert.equal(hasStoredTokens(tokensToConfig({ accessToken: 'at', refreshToken: 'rt' })), true);
  assert.equal(hasStoredTokens({ refresh_token: 'rt' }), true, 'a refresh token is enough');
  assert.equal(hasStoredTokens({ client_id: 'a', poll_frequency: 900 }), false);
  assert.equal(hasStoredTokens(), false);
});

test('a config without a stored session reads as empty, not undefined', () => {
  assert.deepEqual(readTokens(), { accessToken: '', refreshToken: '', expiresAt: 0 });
  assert.deepEqual(readTokens({ client_id: 'a' }), {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
  });
});

test('the tokens never leak into a value the UI would render', () => {
  const config = normalizeConfig({ access_token: 'at', refresh_token: 'rt' });
  // They stay in the object (the SDK hands us the whole config) but they are
  // NOT part of the schema: nothing declares them, nothing renders them.
  assert.equal(config.access_token, 'at');
  assert.equal(Object.keys(DEFAULT_CONFIG).includes('access_token'), false);
});

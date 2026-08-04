import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAIKIN_AUTHORIZE_URL,
  DAIKIN_SCOPE,
  DAIKIN_TOKEN_URL,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  isExpired,
  refreshTokens,
} from '../src/daikin/oauth.js';

const REDIRECT_URI = 'https://my.gladysassistant.com/redirect/oauth';

/**
 * Replace global fetch for one test, and record what was sent.
 * @param {Function} handler answers the request
 * @returns {{ calls: Array<object>, restore: Function }} the recorder
 */
function stubFetch(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: Object.fromEntries(new URLSearchParams(options.body)) });
    return handler(calls.length);
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test('the authorize URL carries the client id, the redirect and the state', () => {
  const url = new URL(
    buildAuthorizeUrl({ clientId: 'my-client', redirectUri: REDIRECT_URI, state: 'abc' }),
  );
  assert.equal(`${url.origin}${url.pathname}`, DAIKIN_AUTHORIZE_URL);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'my-client');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), DAIKIN_SCOPE);
  // Mandatory: Gladys wraps this state to find its way back to the instance.
  assert.equal(url.searchParams.get('state'), 'abc');
});

test('the code is exchanged against the token endpoint, form encoded', async () => {
  const stub = stubFetch(() =>
    jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
  );
  try {
    const before = Date.now();
    const tokens = await exchangeCodeForTokens({
      clientId: 'id',
      clientSecret: 'secret',
      code: 'the-code',
      redirectUri: REDIRECT_URI,
    });
    assert.equal(stub.calls[0].url, DAIKIN_TOKEN_URL);
    assert.equal(stub.calls[0].options.method, 'POST');
    assert.equal(
      stub.calls[0].options.headers['Content-Type'],
      'application/x-www-form-urlencoded',
    );
    assert.deepEqual(stub.calls[0].body, {
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      client_id: 'id',
      client_secret: 'secret',
    });
    assert.equal(tokens.accessToken, 'at');
    assert.equal(tokens.refreshToken, 'rt');
    assert.ok(tokens.expiresAt >= before + 3600 * 1000);
  } finally {
    stub.restore();
  }
});

test('a refused exchange surfaces the reason the provider gave', async () => {
  const stub = stubFetch(() =>
    jsonResponse(400, { error: 'invalid_client', error_description: 'Wrong secret' }),
  );
  try {
    await assert.rejects(
      () =>
        exchangeCodeForTokens({
          clientId: 'id',
          clientSecret: 'nope',
          code: 'c',
          redirectUri: REDIRECT_URI,
        }),
      /Wrong secret/,
    );
  } finally {
    stub.restore();
  }
});

test('an answer without an access token is an error, not an empty session', async () => {
  const stub = stubFetch(() => jsonResponse(200, {}));
  try {
    await assert.rejects(
      () =>
        exchangeCodeForTokens({
          clientId: 'id',
          clientSecret: 's',
          code: 'c',
          redirectUri: REDIRECT_URI,
        }),
      /did not contain an access token/,
    );
  } finally {
    stub.restore();
  }
});

test('a refresh keeps the previous refresh token when Daikin omits a new one', async () => {
  const stub = stubFetch(() => jsonResponse(200, { access_token: 'at2', expires_in: 3600 }));
  try {
    const tokens = await refreshTokens({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'old-rt',
    });
    assert.equal(stub.calls[0].body.grant_type, 'refresh_token');
    assert.equal(stub.calls[0].body.refresh_token, 'old-rt');
    assert.equal(tokens.accessToken, 'at2');
    assert.equal(
      tokens.refreshToken,
      'old-rt',
      'rotating to an empty token would lose the session',
    );
  } finally {
    stub.restore();
  }
});

test('a rotated refresh token replaces the previous one', async () => {
  const stub = stubFetch(() =>
    jsonResponse(200, { access_token: 'at2', refresh_token: 'new-rt', expires_in: 3600 }),
  );
  try {
    const tokens = await refreshTokens({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'old-rt',
    });
    assert.equal(tokens.refreshToken, 'new-rt');
  } finally {
    stub.restore();
  }
});

test('a token is renewed slightly before its real expiry', () => {
  const now = 1_000_000;
  assert.equal(
    isExpired({ accessToken: '', expiresAt: now + 3600_000 }, now),
    true,
    'no token at all',
  );
  assert.equal(isExpired({ accessToken: 'at', expiresAt: now + 3600_000 }, now), false);
  assert.equal(
    isExpired({ accessToken: 'at', expiresAt: now + 30_000 }, now),
    true,
    'inside the safety margin',
  );
  assert.equal(
    isExpired({ accessToken: 'at', expiresAt: 0 }, now),
    false,
    'no expiry known: let a 401 decide',
  );
});

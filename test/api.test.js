import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAIKIN_API_URL, DaikinApi, DaikinApiError } from '../src/daikin/api.js';
import { DAIKIN_TOKEN_URL } from '../src/daikin/oauth.js';

const HOUR_MS = 3600 * 1000;

/**
 * Replace global fetch with a scripted sequence of answers.
 * @param {Array<Function>} answers one function per expected call
 * @returns {{ calls: Array<object>, restore: Function }} the recorder
 */
function stubFetch(answers) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return answer(calls.length);
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

const response = ({ status = 200, payload = {}, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => payload,
});

/**
 * @param {object} [options] the initial session
 * @returns {DaikinApi} an authenticated client
 */
function createApi({ expiresAt = Date.now() + HOUR_MS, onTokensRefreshed } = {}) {
  const api = new DaikinApi({ onTokensRefreshed });
  api.setCredentials({ clientId: 'id', clientSecret: 'secret' });
  api.setTokens({ accessToken: 'at', refreshToken: 'rt', expiresAt });
  return api;
}

test('a client without a session refuses to call the API', async () => {
  const api = new DaikinApi();
  assert.equal(api.isConnected, false);
  await assert.rejects(
    () => api.getGatewayDevices(),
    (err) => err instanceof DaikinApiError && err.status === 401,
  );
});

test('gateway devices are read with the bearer token', async () => {
  const stub = stubFetch([() => response({ payload: [{ id: 'a' }] })]);
  try {
    const devices = await createApi().getGatewayDevices();
    assert.equal(stub.calls[0].url, `${DAIKIN_API_URL}/v1/gateway-devices`);
    assert.equal(stub.calls[0].options.headers.Authorization, 'Bearer at');
    assert.deepEqual(devices, [{ id: 'a' }]);
  } finally {
    stub.restore();
  }
});

test('a non-array answer degrades to an empty list', async () => {
  const stub = stubFetch([() => response({ payload: { message: 'nope' } })]);
  try {
    assert.deepEqual(await createApi().getGatewayDevices(), []);
  } finally {
    stub.restore();
  }
});

test('a command is a PATCH on the characteristic, with the path when there is one', async () => {
  const stub = stubFetch([() => response({ status: 204 })]);
  try {
    await createApi().setCharacteristic({
      deviceId: 'dev',
      embeddedId: 'climateControl',
      characteristic: 'temperatureControl',
      path: '/operationModes/cooling/setpoints/roomTemperature',
      value: 21,
    });
    const call = stub.calls[0];
    assert.equal(
      call.url,
      `${DAIKIN_API_URL}/v1/gateway-devices/dev/management-points/climateControl/characteristics/temperatureControl`,
    );
    assert.equal(call.options.method, 'PATCH');
    assert.deepEqual(JSON.parse(call.options.body), {
      value: 21,
      path: '/operationModes/cooling/setpoints/roomTemperature',
    });
  } finally {
    stub.restore();
  }
});

test('a characteristic without a path sends the value alone', async () => {
  const stub = stubFetch([() => response({ status: 204 })]);
  try {
    await createApi().setCharacteristic({
      deviceId: 'dev',
      embeddedId: 'climateControl',
      characteristic: 'onOffMode',
      value: 'on',
    });
    assert.deepEqual(JSON.parse(stub.calls[0].options.body), { value: 'on' });
  } finally {
    stub.restore();
  }
});

test('an expired token is refreshed before the request, and persisted', async () => {
  const saved = [];
  const stub = stubFetch([
    // 1. the token endpoint, 2. the API call
    (call) =>
      call === 1
        ? response({ payload: { access_token: 'fresh', refresh_token: 'rt2', expires_in: 3600 } })
        : response({ payload: [] }),
  ]);
  try {
    const api = createApi({
      expiresAt: Date.now() - 1000,
      onTokensRefreshed: (tokens) => saved.push(tokens),
    });
    await api.getGatewayDevices();
    assert.equal(stub.calls[0].url, DAIKIN_TOKEN_URL, 'the refresh comes first');
    assert.equal(stub.calls[1].options.headers.Authorization, 'Bearer fresh');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].accessToken, 'fresh');
  } finally {
    stub.restore();
  }
});

test('a 401 triggers exactly one refresh and one retry', async () => {
  const stub = stubFetch([
    (call) => {
      if (call === 1) {
        return response({ status: 401 });
      }
      if (call === 2) {
        return response({ payload: { access_token: 'fresh', expires_in: 3600 } });
      }
      return response({ payload: [] });
    },
  ]);
  try {
    await createApi().getGatewayDevices();
    assert.equal(stub.calls.length, 3);
    assert.equal(stub.calls[1].url, DAIKIN_TOKEN_URL);
    assert.equal(stub.calls[2].options.headers.Authorization, 'Bearer fresh');
  } finally {
    stub.restore();
  }
});

test('a session that cannot be refreshed asks the user to reconnect', async () => {
  const api = new DaikinApi();
  api.setCredentials({ clientId: 'id', clientSecret: 'secret' });
  api.setTokens({ accessToken: 'at', refreshToken: '', expiresAt: Date.now() - 1000 });
  await assert.rejects(
    () => api.getGatewayDevices(),
    (err) => err.isAuthError === true && /please reconnect/.test(err.message),
  );
});

test('a spent quota is reported as such, not as a generic failure', async () => {
  const stub = stubFetch([
    () => response({ status: 429, headers: { 'X-RateLimit-Remaining-day': '0' } }),
  ]);
  try {
    const api = createApi();
    await assert.rejects(
      () => api.getGatewayDevices(),
      (err) => err.isRateLimited === true && /quota/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test('the remaining quota is read from the response headers', async () => {
  const stub = stubFetch([
    () =>
      response({
        payload: [],
        headers: {
          'X-RateLimit-Limit-day': '200',
          'X-RateLimit-Limit-minute': '20',
          'X-RateLimit-Remaining-day': '184',
          'X-RateLimit-Remaining-minute': '19',
        },
      }),
  ]);
  try {
    const api = createApi();
    await api.getGatewayDevices();
    assert.deepEqual(api.rateLimits, {
      limitDay: 200,
      limitMinute: 20,
      remainingDay: 184,
      remainingMinute: 19,
    });
  } finally {
    stub.restore();
  }
});

test('an API error keeps the status and the message Daikin returned', async () => {
  const stub = stubFetch([() => response({ status: 422, payload: { message: 'Invalid value' } })]);
  try {
    await assert.rejects(
      () => createApi().getGatewayDevices(),
      (err) => err.status === 422 && /Invalid value/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test('concurrent calls with an expired token refresh it only once', async () => {
  let refreshes = 0;
  const stub = stubFetch([
    (call) => {
      if (call === 1) {
        refreshes += 1;
        return response({ payload: { access_token: 'fresh', expires_in: 3600 } });
      }
      return response({ payload: [] });
    },
  ]);
  try {
    const api = createApi({ expiresAt: Date.now() - 1000 });
    await Promise.all([api.getGatewayDevices(), api.getGatewayDevices(), api.getGatewayDevices()]);
    assert.equal(
      refreshes,
      1,
      'a second refresh would invalidate the token the first one just got',
    );
    assert.equal(stub.calls.length, 4, 'one refresh plus the three reads');
  } finally {
    stub.restore();
  }
});

test('a failed request does not break the ones queued behind it', async () => {
  const stub = stubFetch([
    (call) => (call === 1 ? response({ status: 500 }) : response({ payload: [{ id: 'a' }] })),
  ]);
  try {
    const api = createApi();
    await assert.rejects(() => api.getGatewayDevices());
    assert.deepEqual(await api.getGatewayDevices(), [{ id: 'a' }]);
  } finally {
    stub.restore();
  }
});

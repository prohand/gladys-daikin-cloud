// -----------------------------------------------------------------------------
// Daikin Onecta REST client.
//
// Two endpoints are all this integration needs:
//   - GET   /v1/gateway-devices
//       the FULL state of every unit of the account, in one call;
//   - PATCH /v1/gateway-devices/{id}/management-points/{embeddedId}/characteristics/{name}
//       body `{ value }`, plus a `path` for the characteristics that carry a
//       tree of values (temperature setpoints, fan control...).
//
// The client owns the access token lifecycle: it refreshes before a request
// when the token is about to expire, and once more when the API answers 401.
// Every renewal is handed back through the `onTokensRefreshed` callback so the
// caller persists it in the Gladys configuration.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isExpired, refreshTokens } from './oauth.js';

const logger = createLogger({ name: 'daikin-api' });

export const DAIKIN_API_URL = 'https://api.onecta.daikineurope.com';

const REQUEST_TIMEOUT_MS = 20_000;

/** Error carrying the HTTP status, so callers can tell a quota from a bug. */
export class DaikinApiError extends Error {
  /**
   * @param {number} status the HTTP status returned by the Daikin cloud
   * @param {string} message the human readable reason
   */
  constructor(status, message) {
    super(message);
    this.name = 'DaikinApiError';
    this.status = status;
    /** The daily/minute quota is spent: retrying now only makes it worse. */
    this.isRateLimited = status === 429;
    /** The session is dead beyond a refresh: the user must reconnect. */
    this.isAuthError = status === 401 || status === 403;
  }
}

export class DaikinApi {
  /**
   * @param {{ onTokensRefreshed?: Function }} [options] called with the renewed session
   */
  constructor({ onTokensRefreshed } = {}) {
    this.credentials = { clientId: '', clientSecret: '' };
    this.tokens = { accessToken: '', refreshToken: '', expiresAt: 0 };
    this.onTokensRefreshed = onTokensRefreshed;
    // Last values of the X-RateLimit-* headers, surfaced in the "Test the
    // connection" action so the user can see what is left of the daily budget.
    this.rateLimits = {
      remainingDay: null,
      remainingMinute: null,
      limitDay: null,
      limitMinute: null,
    };
    // Serialize the requests: two parallel calls with an expired token would
    // both refresh, and the second refresh invalidates the first token.
    this.pending = Promise.resolve();
  }

  /**
   * @param {{ clientId: string, clientSecret: string }} credentials the developer application credentials
   */
  setCredentials({ clientId, clientSecret }) {
    this.credentials = { clientId, clientSecret };
  }

  /**
   * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens the stored session
   */
  setTokens(tokens) {
    this.tokens = { ...tokens };
  }

  /** @returns {boolean} true when a Daikin account is linked */
  get isConnected() {
    return Boolean(this.tokens.accessToken || this.tokens.refreshToken);
  }

  /**
   * Read every gateway device (and every management point) of the account.
   * @returns {Promise<Array<Record<string, unknown>>>} the raw Daikin payload
   */
  async getGatewayDevices() {
    const devices = await this.request('GET', '/v1/gateway-devices');
    return Array.isArray(devices) ? devices : [];
  }

  /**
   * Write one characteristic of one management point.
   * @param {{ deviceId: string, embeddedId: string, characteristic: string, value: unknown, path?: string }} command the write to perform
   * @returns {Promise<void>} resolves once the Daikin cloud accepted the write
   */
  async setCharacteristic({ deviceId, embeddedId, characteristic, value, path }) {
    const url = `/v1/gateway-devices/${deviceId}/management-points/${embeddedId}/characteristics/${characteristic}`;
    const body = path ? { value, path } : { value };
    logger.info(`PATCH ${characteristic}${path ? path : ''} = ${JSON.stringify(value)}`);
    await this.request('PATCH', url, body);
  }

  /**
   * Run an authenticated request, refreshing the access token when needed.
   * Requests are queued so a token renewal never happens twice at once.
   * @param {string} method the HTTP method
   * @param {string} path the path, relative to the API root
   * @param {unknown} [body] the JSON body, for writes
   * @returns {Promise<unknown>} the parsed answer (undefined for a 204)
   */
  async request(method, path, body) {
    const run = this.pending.then(
      () => this.doRequest(method, path, body),
      () => this.doRequest(method, path, body),
    );
    // Keep the chain alive whatever happens to this request.
    this.pending = run.catch(() => {});
    return run;
  }

  /**
   * The actual request, with the single automatic retry on 401.
   * @param {string} method the HTTP method
   * @param {string} path the path, relative to the API root
   * @param {unknown} [body] the JSON body, for writes
   * @returns {Promise<unknown>} the parsed answer (undefined for a 204)
   */
  async doRequest(method, path, body) {
    if (!this.isConnected) {
      throw new DaikinApiError(401, 'No Daikin account linked yet');
    }
    if (isExpired(this.tokens)) {
      await this.renewTokens();
    }

    let response = await this.send(method, path, body);
    if (response.status === 401) {
      // The token was refused earlier than its advertised expiry (revoked,
      // rotated server-side...): renew once, then give up.
      logger.warn('Daikin refused the access token, refreshing it once');
      await this.renewTokens();
      response = await this.send(method, path, body);
    }

    this.readRateLimits(response);

    if (response.status === 204) {
      return undefined;
    }
    if (!response.ok) {
      throw new DaikinApiError(response.status, await describeError(response));
    }
    return response.json();
  }

  /**
   * One HTTP round trip, with the bearer token attached.
   * @param {string} method the HTTP method
   * @param {string} path the path, relative to the API root
   * @param {unknown} [body] the JSON body, for writes
   * @returns {Promise<Response>} the raw fetch response
   */
  async send(method, path, body) {
    return fetch(`${DAIKIN_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Renew the access token and publish the new session to the caller.
   * @returns {Promise<void>} resolves once the new session is stored
   */
  async renewTokens() {
    if (!this.tokens.refreshToken) {
      throw new DaikinApiError(401, 'The Daikin session expired, please reconnect the account');
    }
    try {
      this.tokens = await refreshTokens({
        clientId: this.credentials.clientId,
        clientSecret: this.credentials.clientSecret,
        refreshToken: this.tokens.refreshToken,
      });
    } catch (err) {
      throw new DaikinApiError(401, `Could not refresh the Daikin session: ${err.message}`);
    }
    if (typeof this.onTokensRefreshed === 'function') {
      await this.onTokensRefreshed({ ...this.tokens });
    }
  }

  /**
   * Remember what Daikin says is left of the quota.
   * @param {Response} response the raw fetch response
   */
  readRateLimits(response) {
    const read = (header) => {
      const value = response.headers?.get?.(header);
      return value === null || value === undefined || value === '' ? null : Number(value);
    };
    this.rateLimits = {
      limitDay: read('X-RateLimit-Limit-day'),
      limitMinute: read('X-RateLimit-Limit-minute'),
      remainingDay: read('X-RateLimit-Remaining-day'),
      remainingMinute: read('X-RateLimit-Remaining-minute'),
    };
  }
}

/**
 * Turn an error answer into a message worth showing to the user.
 * @param {Response} response the failed fetch response
 * @returns {Promise<string>} the description of the failure
 */
async function describeError(response) {
  if (response.status === 429) {
    return 'Daikin API quota reached (200 requests/day, 20/minute), try again later';
  }
  let detail;
  try {
    const body = await response.json();
    detail = body?.message || body?.error_description || body?.error || '';
  } catch {
    detail = '';
  }
  return detail
    ? `Daikin API error ${response.status}: ${detail}`
    : `Daikin API error ${response.status}`;
}

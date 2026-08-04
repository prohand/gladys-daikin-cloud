// -----------------------------------------------------------------------------
// Daikin Onecta OAuth2 (authorization code flow).
//
// The user creates an application on the Daikin developer portal, which gives
// a client id + client secret and asks for the redirect URI to whitelist. That
// redirect URI is displayed (and copyable) next to the "Connect" button in the
// Gladys Configuration screen, and Gladys hands it back to us in both OAuth
// handlers — the exchange only succeeds when the SAME value is replayed.
//
// Gladys knows no provider: this file is the only place that talks to Daikin's
// identity provider.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'daikin-oauth' });

export const DAIKIN_AUTHORIZE_URL = 'https://idp.onecta.daikineurope.com/v1/oidc/authorize';
export const DAIKIN_TOKEN_URL = 'https://idp.onecta.daikineurope.com/v1/oidc/token';
// The single scope a developer-portal application is granted.
export const DAIKIN_SCOPE = 'openid onecta:basic.integration';

const REQUEST_TIMEOUT_MS = 15_000;
// Refresh a bit before the real expiry so a long request never races the clock.
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Build the URL the user is sent to in order to authorize Gladys on their
 * Daikin account.
 * @param {{ clientId: string, redirectUri: string, state: string }} params the flow parameters
 * @returns {string} the provider authorization URL
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(DAIKIN_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', DAIKIN_SCOPE);
  // Mandatory: Gladys wraps this state with the address of the instance for the
  // round trip, and hands the original value back to us in the callback.
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange the authorization code for a token pair.
 * @param {{ clientId: string, clientSecret: string, code: string, redirectUri: string }} params the exchange parameters
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>} the session
 */
export async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri }) {
  logger.info('Exchanging the authorization code for tokens');
  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

/**
 * Renew an expired access token. Daikin rotates the refresh token on some
 * responses and omits it on others, so the caller keeps the previous one when
 * the answer does not carry a new value.
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} params the refresh parameters
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>} the renewed session
 */
export async function refreshTokens({ clientId, clientSecret, refreshToken }) {
  logger.info('Refreshing the Daikin access token');
  const tokens = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

/**
 * Whether an access token is missing or about to expire.
 * @param {{ accessToken: string, expiresAt: number }} tokens the current session
 * @param {number} [now] current epoch time in ms, injectable for the tests
 * @returns {boolean} true when the token must be refreshed before being used
 */
export function isExpired(tokens, now = Date.now()) {
  if (!tokens.accessToken) {
    return true;
  }
  // No expiry stored (e.g. a provider answer without expires_in): trust the
  // token and let a 401 trigger the refresh.
  if (!tokens.expiresAt) {
    return false;
  }
  return tokens.expiresAt - EXPIRY_MARGIN_MS <= now;
}

/**
 * POST the token endpoint and normalize its answer.
 * @param {Record<string, string>} body the form-encoded parameters
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>} the session
 */
async function postToken(body) {
  const response = await fetch(DAIKIN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await readJson(response);

  if (!response.ok) {
    // The provider describes the refusal in `error` / `error_description`:
    // surfacing it is what tells the user "wrong secret" from "expired code".
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Daikin token request refused: ${detail}`);
  }

  if (!payload.access_token) {
    throw new Error('Daikin token response did not contain an access token');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || '',
    expiresAt: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : 0,
  };
}

/**
 * Parse a JSON body without throwing on an empty or malformed answer.
 * @param {Response} response the fetch response
 * @returns {Promise<Record<string, unknown>>} the parsed body, or an empty object
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

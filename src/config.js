// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills in the fields declared in the `config_schema` of
// `gladys-assistant-integration.json`; the SDK fetches the values
// (`gladys.getConfig()`) and pushes every change through
// `gladys.onConfigUpdated()`.
//
// The OAuth2 tokens live in the SAME configuration store but OUTSIDE the
// schema: keys unknown to `config_schema` are free internal storage, never
// rendered in the UI and never sent to the frontend. They are written by the
// OAuth callback through `gladys.setConfig()`.
// -----------------------------------------------------------------------------

// Keys used to persist the Daikin OAuth2 session. NOT part of config_schema.
export const TOKEN_KEYS = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  EXPIRES_AT: 'token_expires_at',
};

// Daikin's Onecta plan allows 200 requests per day and 20 per minute for a
// developer account. One refresh reads EVERY unit of the account in a single
// `GET /v1/gateway-devices`, so the daily budget is really "one poll every N
// seconds, plus the commands the user sends". 900 s = 96 polls/day leaves a
// comfortable margin for commands; below 600 s the quota is spent before the
// day ends. Hence the bounds below, mirrored in the manifest.
export const MIN_POLL_FREQUENCY = 600;
export const MAX_POLL_FREQUENCY = 21600;

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (a test enforces it).
export const DEFAULT_CONFIG = {
  poll_frequency: 900, // seconds between two reads of the Daikin cloud
};

/**
 * Merge the user config with the defaults and force the types (a form can
 * send numbers as strings), so the rest of the code never deals with
 * `undefined`.
 * @param {Record<string, unknown>} raw config returned by the SDK
 * @returns {Record<string, unknown>} the normalized configuration
 */
export function normalizeConfig(raw = {}) {
  const pollFrequency = Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    client_id: typeof raw.client_id === 'string' ? raw.client_id.trim() : '',
    client_secret: typeof raw.client_secret === 'string' ? raw.client_secret.trim() : '',
    poll_frequency: clampPollFrequency(pollFrequency),
  };
}

/**
 * Keep the polling interval inside the bounds the Daikin quota allows, even if
 * an out-of-range value reaches us (older stored config, manual API call).
 * @param {number} value the requested interval, in seconds
 * @returns {number} the interval actually used, in seconds
 */
export function clampPollFrequency(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.poll_frequency;
  }
  return Math.min(MAX_POLL_FREQUENCY, Math.max(MIN_POLL_FREQUENCY, Math.round(value)));
}

/**
 * The developer credentials are what the OAuth2 flow needs to even start.
 * @param {Record<string, unknown>} config the normalized configuration
 * @returns {boolean} true when both the client id and the secret are set
 */
export function hasCredentials(config) {
  return Boolean(config.client_id) && Boolean(config.client_secret);
}

/**
 * Read the stored OAuth2 session out of the configuration.
 * @param {Record<string, unknown>} config the raw or normalized configuration
 * @returns {{ accessToken: string, refreshToken: string, expiresAt: number }} the session
 */
export function readTokens(config = {}) {
  return {
    accessToken: config[TOKEN_KEYS.ACCESS_TOKEN] || '',
    refreshToken: config[TOKEN_KEYS.REFRESH_TOKEN] || '',
    expiresAt: Number(config[TOKEN_KEYS.EXPIRES_AT]) || 0,
  };
}

/**
 * Build the partial configuration to hand to `gladys.setConfig()` to persist a
 * refreshed OAuth2 session.
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens the session
 * @returns {Record<string, unknown>} the partial config to save
 */
export function tokensToConfig(tokens) {
  return {
    [TOKEN_KEYS.ACCESS_TOKEN]: tokens.accessToken,
    [TOKEN_KEYS.REFRESH_TOKEN]: tokens.refreshToken,
    [TOKEN_KEYS.EXPIRES_AT]: tokens.expiresAt,
  };
}

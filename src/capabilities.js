// -----------------------------------------------------------------------------
// What the Gladys instance running this integration can accept.
//
// Publishing a feature type — or a feature field — an older core does not know
// makes the WHOLE discovery payload fail, so the catalog is built from what the
// connected instance actually supports. Two thresholds matter here:
//
//   - the FAN category (fan mode, speed level, oscillation) exists since
//     Gladys 4.79.0. Below that, the unit gets its climate controls only;
//   - the per-axis airflow direction (air conditioning swing-horizontal /
//     swing-vertical) and `supported_options`, which restricts a select to the
//     values the hardware accepts, both landed in 4.84.3. Below that the
//     louvers fall back to the single oscillation feature of the FAN category,
//     and the mode lists are offered in full.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'capabilities' });

// First Gladys version shipping DEVICE_FEATURE_CATEGORIES.FAN and its types.
const FAN_CATEGORY_MIN_VERSION = [4, 79, 0];
// First Gladys version storing the per-feature supported_options AND knowing
// the per-axis air conditioning swing types.
const SUPPORTED_OPTIONS_MIN_VERSION = [4, 84, 3];

export const DEFAULT_CAPABILITIES = {
  fanCategory: false,
  supportedOptions: false,
  acSwing: false,
};

/**
 * Ask the connected Gladys what it is, and derive the feature catalog from it.
 * A failure here is never fatal: the integration falls back to the features
 * every supported Gladys understands.
 * @param {object} gladys the SDK instance
 * @returns {Promise<{ fanCategory: boolean, supportedOptions: boolean, acSwing: boolean }>} the capabilities of the instance
 */
export async function detectCapabilities(gladys) {
  try {
    const status = await gladys.getStatus();
    const capabilities = capabilitiesForVersion(status?.gladys_version);
    logger.info(
      `Gladys ${status?.gladys_version}: fan features ${capabilities.fanCategory ? 'enabled' : 'disabled (4.79.0+ required)'}, ` +
        `per-axis airflow and restricted mode lists ${capabilities.acSwing ? 'enabled' : 'disabled (4.84.3+ required)'}`,
    );
    return capabilities;
  } catch (err) {
    logger.warn('Could not read the Gladys version, publishing the base features only', err);
    return { ...DEFAULT_CAPABILITIES };
  }
}

/**
 * @param {string} version the Gladys version, e.g. '4.84.3'
 * @returns {{ fanCategory: boolean, supportedOptions: boolean, acSwing: boolean }} the capabilities of that version
 */
export function capabilitiesForVersion(version) {
  const supportedOptions = isAtLeast(version, SUPPORTED_OPTIONS_MIN_VERSION);
  return {
    fanCategory: isAtLeast(version, FAN_CATEGORY_MIN_VERSION),
    supportedOptions,
    // Same release: both are what 4.84.3 added to the air conditioning model.
    acSwing: supportedOptions,
  };
}

/**
 * Compare a `major.minor.patch` version against a minimum. Pre-release
 * suffixes are ignored: `4.85.0-beta.1` counts as `4.85.0`.
 * @param {string} version the version to test
 * @param {Array<number>} minimum the minimum version, as [major, minor, patch]
 * @returns {boolean} true when the version is greater than or equal to the minimum
 */
export function isAtLeast(version, minimum) {
  if (typeof version !== 'string') {
    return false;
  }
  const parsed = version
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (parsed.length < 3 || parsed.some((part) => !Number.isInteger(part))) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== minimum[index]) {
      return parsed[index] > minimum[index];
    }
  }
  return true;
}

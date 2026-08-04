// -----------------------------------------------------------------------------
// What the Gladys instance running this integration can accept.
//
// The air conditioning fan speed and swing feature types — and the
// `supported_options` that restrict their choices to what the hardware offers —
// landed in Gladys 4.84.3. Publishing a feature type an older core does not
// know makes the whole discovery payload fail, so the catalog is built from
// what the connected instance actually supports: everyone gets on/off, mode,
// target temperature and the sensors; recent instances also get the fan and
// the louvers.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'capabilities' });

// First Gladys version shipping AIR_CONDITIONING.FAN_SPEED / SWING_* and the
// per-feature supported_options.
const FAN_AND_SWING_MIN_VERSION = [4, 84, 3];

export const DEFAULT_CAPABILITIES = { fanAndSwing: false };

/**
 * Ask the connected Gladys what it is, and derive the feature catalog from it.
 * A failure here is never fatal: the integration falls back to the features
 * every supported Gladys understands.
 * @param {object} gladys the SDK instance
 * @returns {Promise<{ fanAndSwing: boolean }>} the capabilities of the instance
 */
export async function detectCapabilities(gladys) {
  try {
    const status = await gladys.getStatus();
    const capabilities = capabilitiesForVersion(status?.gladys_version);
    logger.info(
      `Gladys ${status?.gladys_version}: fan speed and swing features ${capabilities.fanAndSwing ? 'enabled' : 'disabled (Gladys 4.84.3+ required)'}`,
    );
    return capabilities;
  } catch (err) {
    logger.warn('Could not read the Gladys version, publishing the base features only', err);
    return { ...DEFAULT_CAPABILITIES };
  }
}

/**
 * @param {string} version the Gladys version, e.g. '4.84.3'
 * @returns {{ fanAndSwing: boolean }} the capabilities of that version
 */
export function capabilitiesForVersion(version) {
  return { fanAndSwing: isAtLeast(version, FAN_AND_SWING_MIN_VERSION) };
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

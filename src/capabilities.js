// -----------------------------------------------------------------------------
// What the Gladys instance running this integration can accept.
//
// Publishing a feature type an older core does not know makes the WHOLE
// discovery payload fail. The obvious fix — read the Gladys version and derive
// the catalog from it — turned out to be a trap: the probe is a single point of
// failure, and when it fails (or returns a version string this code cannot
// parse) it silently strips the fan and the louvers while leaving the rest, so
// the user sees an integration that half works with nothing explaining why.
//
// So the catalog is no longer guessed. The integration PUBLISHES the richest
// catalog and lets Gladys refuse it, stepping down a level at a time until one
// is accepted. That is self-correcting: a new Gladys gets everything, an old
// one gets what it understands, and neither depends on a version table staying
// up to date.
//
// One exception stays version-gated. `supported_options` (restricting a select
// to the values the hardware accepts) is not validated when the devices are
// published but when the user CREATES the device, which no retry here can
// catch. It is therefore only sent to a Gladys known to store it — and when the
// version cannot be read, it is left out. The cost is a dropdown offering a few
// modes the unit does not have; the alternative would be a device the user
// cannot create at all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'capabilities' });

// First Gladys version storing the per-feature supported_options.
const SUPPORTED_OPTIONS_MIN_VERSION = [4, 84, 3];

/**
 * The catalogs to try, richest first. Each step drops what the previous Gladys
 * release did not have:
 *   - `full`  : per-axis airflow direction (air conditioning), added in 4.84.3;
 *   - `fan`   : the FAN category (mode, speed, oscillation), added in 4.79;
 *   - `energy`: the 30-minute consumption/cost pair, added in 4.66;
 *   - `base`  : what every supported Gladys understands.
 *
 * The energy monitoring landed BEFORE the fan category and the per-axis swing,
 * so an instance taking either of those takes the pair too: the ladder stays a
 * chain of subsets, and no combination is unreachable.
 */
export const CAPABILITY_LEVELS = [
  { level: 'full', fanCategory: true, acSwing: true, energyMonitoring: true },
  { level: 'fan', fanCategory: true, acSwing: false, energyMonitoring: true },
  { level: 'energy', fanCategory: false, acSwing: false, energyMonitoring: true },
  { level: 'base', fanCategory: false, acSwing: false, energyMonitoring: false },
];

/**
 * Publish the discovered devices, stepping down the catalog until Gladys
 * accepts one. The accepted capabilities are returned so the states published
 * afterwards describe the same features.
 * @param {object} gladys the SDK instance
 * @param {Function} buildDevices `(capabilities) => Array<object>` the payload builder
 * @param {boolean} supportedOptions whether this Gladys stores supported_options
 * @returns {Promise<object>} the capabilities Gladys accepted
 * @throws {Error} when even the base catalog is refused — that is a real bug,
 * not an old Gladys, and it must not be swallowed
 */
export async function publishWithBestCatalog(gladys, buildDevices, supportedOptions) {
  let lastError;
  for (const candidate of CAPABILITY_LEVELS) {
    const capabilities = { ...candidate, supportedOptions };
    try {
      await gladys.publishDiscoveredDevices(buildDevices(capabilities));
      logger.info(`Publishing the "${candidate.level}" catalog (Gladys accepted it)`);
      return capabilities;
    } catch (err) {
      lastError = err;
      logger.warn(
        `Gladys refused the "${candidate.level}" catalog (${err.message}), trying a smaller one`,
      );
    }
  }
  throw lastError;
}

/**
 * Whether this Gladys stores the per-feature supported_options. Unknown or
 * unparseable version: assume it does not.
 * @param {object} gladys the SDK instance
 * @returns {Promise<boolean>} true when supported_options can be sent
 */
export async function detectSupportedOptions(gladys) {
  try {
    const status = await gladys.getStatus();
    const supported = isAtLeast(status?.gladys_version, SUPPORTED_OPTIONS_MIN_VERSION);
    logger.info(
      `Gladys ${status?.gladys_version}: restricted mode lists ${supported ? 'enabled' : 'disabled (4.84.3+ required)'}`,
    );
    return supported;
  } catch (err) {
    logger.warn('Could not read the Gladys version, offering the full mode lists', err);
    return false;
  }
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

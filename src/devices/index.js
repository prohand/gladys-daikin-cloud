// -----------------------------------------------------------------------------
// Device catalog.
//
// Unlike a template with a fixed list of demo devices, the catalog here is
// discovered at runtime: it is whatever the linked Daikin account exposes. This
// module turns the units held by the store into the three payloads Gladys
// expects — discovered devices, transport badges, and the routing of a command
// back to the unit that owns it.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { buildDevice, buildStates, deviceExternalId } from './climateUnit.js';

export {
  buildCommands,
  buildStates,
  deviceExternalId,
  featureExternalId,
  featureKeyOf,
  FEATURE,
} from './climateUnit.js';

/**
 * The complete discovery payload: one Gladys device per Daikin climate unit.
 * @param {object} gladys the SDK instance
 * @param {Array<object>} units the normalized Daikin units
 * @param {{ fanCategory: boolean, supportedOptions: boolean, acSwing: boolean, energyMonitoring: boolean }} capabilities what the Gladys instance accepts
 * @param {Map<string, string>|null} [knownFeatureIds] the ids Gladys already stores, by feature external_id, or null when they could not be read
 * @returns {Array<object>} the devices to publish
 */
export function buildDiscoveredDevices(gladys, units, capabilities, knownFeatureIds) {
  return units.map((unit) => buildDevice(gladys, unit, capabilities, knownFeatureIds));
}

/**
 * Index the features of the devices Gladys already created by their
 * external_id. The energy monitoring pair points at its parent by row id, so
 * the payload has to know which ids Gladys is already holding — the ones it
 * does not know are the only ones this integration may name itself.
 * @param {Array<object>} devices the devices returned by `gladys.getDevices()`
 * @returns {Map<string, string>} the feature ids, by feature external_id
 */
export function featureIdsByExternalId(devices) {
  const ids = new Map();
  for (const device of devices ?? []) {
    for (const feature of device?.features ?? []) {
      if (feature?.external_id && feature?.id) {
        ids.set(feature.external_id, feature.id);
      }
    }
  }
  return ids;
}

/**
 * The states of every unit, in one batch (the SDK accepts up to 100 per call,
 * which covers ~12 units — larger accounts are chunked by the caller).
 * @param {object} gladys the SDK instance
 * @param {Array<object>} units the normalized Daikin units
 * @param {{ fanCategory: boolean, supportedOptions: boolean, acSwing: boolean }} capabilities what the Gladys instance accepts
 * @returns {Array<object>} the states to publish
 */
export function buildAllStates(gladys, units, capabilities) {
  return units.flatMap((unit) => buildStates(gladys, unit, capabilities));
}

/**
 * Route a Gladys device back to the Daikin unit it mirrors.
 * @param {object} gladys the SDK instance
 * @param {Array<object>} units the normalized Daikin units
 * @param {{ external_id: string }} device the device Gladys is talking about
 * @returns {object|undefined} the matching unit, when it still exists
 */
export function findUnitByDevice(gladys, units, device) {
  return units.find((unit) => deviceExternalId(gladys, unit) === device.external_id);
}

/**
 * The transport badge of every unit. This integration is cloud only, so the
 * badge really answers "is this unit reachable right now?": Daikin reports a
 * unit whose Wi-Fi adapter is offline with `isCloudConnectionUp: false`, and
 * that is exactly what the `unreachable` badge is for.
 * @param {object} gladys the SDK instance
 * @param {Array<object>} units the normalized Daikin units
 * @returns {Array<object>} the entries to publish
 */
export function buildTransportEntries(gladys, units) {
  return units.map((unit) => {
    if (!unit.online) {
      return {
        external_id: deviceExternalId(gladys, unit),
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      };
    }
    if (unit.inErrorState) {
      // Reachable, but the unit itself reports a fault: the orange dot tells
      // the user why the commands may not do what they expect.
      return {
        external_id: deviceExternalId(gladys, unit),
        transport: DEVICE_TRANSPORTS.CLOUD,
        degraded: true,
        message: {
          en: 'The unit reports an error, check it in the Onecta app.',
          fr: "L'unité signale une erreur, vérifiez-la dans l'application Onecta.",
        },
      };
    }
    return { external_id: deviceExternalId(gladys, unit), transport: DEVICE_TRANSPORTS.CLOUD };
  });
}

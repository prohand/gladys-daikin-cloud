// -----------------------------------------------------------------------------
// Daikin payload -> normalized "climate unit".
//
// A gateway device (one Wi-Fi adapter) exposes several "management points":
// `gateway`, `indoorUnit`, `outdoorUnit`... and `climateControl`, the one that
// actually heats and cools. This module keeps ONLY the climate control points
// and flattens their characteristics into a plain object, so the rest of the
// integration never walks the Daikin tree again.
//
// Everything here is defensive: the shape of a management point depends on the
// model, its firmware and its options — a missing block means "this unit does
// not have that capability", never an error.
// -----------------------------------------------------------------------------

const CLIMATE_MANAGEMENT_POINT = 'climateControl';
// Air conditioners drive a room temperature setpoint. Heat pumps (Altherma)
// use leavingWaterTemperature/leavingWaterOffset instead: their on/off, mode
// and sensors still work, they simply get no target temperature feature.
export const ROOM_TEMPERATURE_SETPOINT = 'roomTemperature';

/**
 * Turn the raw `GET /v1/gateway-devices` answer into the list of climate units.
 * @param {Array<Record<string, unknown>>} gatewayDevices the raw Daikin payload
 * @returns {Array<object>} one entry per controllable climate management point
 */
export function parseUnits(gatewayDevices = []) {
  const units = [];
  for (const gatewayDevice of gatewayDevices) {
    if (!gatewayDevice || typeof gatewayDevice !== 'object') {
      continue;
    }
    const managementPoints = Array.isArray(gatewayDevice.managementPoints)
      ? gatewayDevice.managementPoints
      : [];
    for (const managementPoint of managementPoints) {
      if (managementPoint?.managementPointType !== CLIMATE_MANAGEMENT_POINT) {
        continue;
      }
      units.push(parseUnit(gatewayDevice, managementPoint));
    }
  }
  return units;
}

/**
 * Build one climate unit from its gateway device and its management point.
 * @param {Record<string, unknown>} gatewayDevice the parent gateway device
 * @param {Record<string, unknown>} managementPoint the climateControl management point
 * @returns {object} the normalized unit
 */
function parseUnit(gatewayDevice, managementPoint) {
  const deviceId = gatewayDevice.id;
  const embeddedId = managementPoint.embeddedId;
  const operationMode = value(managementPoint.operationMode);
  const setpoints = parseSetpoints(managementPoint.temperatureControl);
  const fan = parseFanControl(managementPoint.fanControl, operationMode);

  return {
    deviceId,
    embeddedId,
    // Stable identifier of the Gladys device: a gateway can expose several
    // climate control points (dual-zone units), so the pair is what is unique.
    platformId: `${deviceId}_${embeddedId}`,
    name: value(managementPoint.name) || gatewayDevice.deviceModel || 'Daikin',
    model: gatewayDevice.deviceModel || null,
    online: value(gatewayDevice.isCloudConnectionUp) !== false,
    inErrorState: value(managementPoint.isInErrorState) === true,
    power: value(managementPoint.onOffMode) || null,
    operationMode,
    operationModes: values(managementPoint.operationMode),
    // Setpoint bounds are per operation mode: the current one drives the
    // published state, the union drives the min/max of the Gladys feature.
    setpoints,
    setpoint: operationMode ? (setpoints[operationMode] ?? null) : null,
    roomTemperature: sensor(managementPoint.sensoryData, 'roomTemperature'),
    outdoorTemperature: sensor(managementPoint.sensoryData, 'outdoorTemperature'),
    fan,
  };
}

/**
 * Collect the room temperature setpoint of every operation mode that has one.
 * @param {Record<string, unknown>} temperatureControl the temperatureControl characteristic
 * @returns {Record<string, { value: number, min: number, max: number, step: number }>} setpoints by mode
 */
function parseSetpoints(temperatureControl) {
  const operationModes = temperatureControl?.value?.operationModes;
  if (!operationModes || typeof operationModes !== 'object') {
    return {};
  }
  const setpoints = {};
  for (const [mode, modeData] of Object.entries(operationModes)) {
    const setpoint = modeData?.setpoints?.[ROOM_TEMPERATURE_SETPOINT];
    if (!setpoint || typeof setpoint.value !== 'number') {
      continue;
    }
    setpoints[mode] = {
      value: setpoint.value,
      min: numberOr(setpoint.minValue, setpoint.value),
      max: numberOr(setpoint.maxValue, setpoint.value),
      step: numberOr(setpoint.stepValue, 0.5),
      settable: setpoint.settable !== false,
    };
  }
  return setpoints;
}

/**
 * Extract the fan speed and airflow direction of the CURRENT operation mode:
 * Daikin describes them per mode, and only the active one can be driven.
 * @param {Record<string, unknown>} fanControl the fanControl characteristic
 * @param {string|null} operationMode the active operation mode
 * @returns {object|null} the normalized fan capabilities, or null when absent
 */
function parseFanControl(fanControl, operationMode) {
  const modeData = operationMode ? fanControl?.value?.operationModes?.[operationMode] : null;
  if (!modeData) {
    return null;
  }

  const speed = modeData.fanSpeed
    ? {
        currentMode: modeData.fanSpeed.currentMode?.value ?? null,
        modes: Array.isArray(modeData.fanSpeed.currentMode?.values)
          ? modeData.fanSpeed.currentMode.values
          : [],
        fixed: modeData.fanSpeed.modes?.fixed
          ? {
              value: numberOr(modeData.fanSpeed.modes.fixed.value, 1),
              min: numberOr(modeData.fanSpeed.modes.fixed.minValue, 1),
              max: numberOr(modeData.fanSpeed.modes.fixed.maxValue, 5),
              step: numberOr(modeData.fanSpeed.modes.fixed.stepValue, 1),
            }
          : null,
      }
    : null;

  const direction = {};
  for (const axis of ['horizontal', 'vertical']) {
    const currentMode = modeData.fanDirection?.[axis]?.currentMode;
    if (!currentMode) {
      continue;
    }
    direction[axis] = {
      value: currentMode.value ?? null,
      values: Array.isArray(currentMode.values) ? currentMode.values : [],
    };
  }

  if (!speed && Object.keys(direction).length === 0) {
    return null;
  }
  return { speed, direction: Object.keys(direction).length > 0 ? direction : null };
}

/**
 * Read a `{ value }` characteristic.
 * @param {Record<string, unknown>} characteristic the Daikin characteristic
 * @returns {unknown} its value, or null
 */
function value(characteristic) {
  return characteristic?.value ?? null;
}

/**
 * Read the allowed values of a `{ value, values }` characteristic.
 * @param {Record<string, unknown>} characteristic the Daikin characteristic
 * @returns {Array<string>} the values the unit accepts
 */
function values(characteristic) {
  return Array.isArray(characteristic?.values) ? characteristic.values : [];
}

/**
 * Read one entry of the `sensoryData` block.
 * @param {Record<string, unknown>} sensoryData the sensoryData characteristic
 * @param {string} key the sensor name
 * @returns {number|null} the measured value, or null when the unit has no such sensor
 */
function sensor(sensoryData, key) {
  const measure = sensoryData?.value?.[key]?.value;
  return typeof measure === 'number' ? measure : null;
}

/**
 * @param {unknown} candidate the value to read
 * @param {number} fallback the value to use when the candidate is not a number
 * @returns {number} a usable number
 */
function numberOr(candidate, fallback) {
  return typeof candidate === 'number' ? candidate : fallback;
}

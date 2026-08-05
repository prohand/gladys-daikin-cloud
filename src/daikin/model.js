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
  // "Keep dry" lives on the indoor unit, not on the climate control point.
  const indoorUnit = findManagementPoint(gatewayDevice, 'indoorUnit');

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
    energy: parseConsumption(managementPoint.consumptionData),
    // Every characteristic name the unit declares, per management point. Not
    // used to drive anything: it is what lets the "Test the connection" action
    // answer "this model does not report it" instead of leaving the user to
    // guess whether the integration simply ignores it.
    characteristics: collectCharacteristics(gatewayDevice),
    // The comfort toggles, each `on`/`off` and each optional on a given model.
    toggles: {
      powerful: toggle(managementPoint.powerfulMode),
      econo: toggle(managementPoint.econoMode),
      streamer: toggle(managementPoint.streamerMode),
      // Often reported read-only by the API: the flag says so, the feature
      // is published accordingly rather than pretending to be actionable.
      dryKeep: toggle(indoorUnit?.dryKeepSetting, indoorUnit?.embeddedId),
    },
  };
}

// Daikin reports electrical consumption as fixed-length buckets, two periods
// deep, and the split is positional — nothing in the payload labels it:
//   `d`: 24 two-hour slots, the first 12 for YESTERDAY, the last 12 for today;
//   `m`: 24 months, the first 12 for LAST year, the last 12 for this one.
// Reading the whole array would therefore double-count the previous period.
const DAILY_TODAY_FROM = 12;
const MONTHLY_THIS_YEAR_FROM = 12;

/**
 * Total electrical consumption of a unit, in kWh, for the periods worth
 * charting. Daikin splits its buckets per operation mode (heating, cooling…);
 * they are summed, because what a dashboard wants is what the unit consumed,
 * not how it was split.
 * @param {Record<string, unknown>} consumptionData the consumptionData characteristic
 * @param {Date} [now] the current date, injectable for the tests
 * @returns {{ today: number, thisMonth: number, thisYear: number }|null} the totals, or null when the unit reports none
 */
export function parseConsumption(consumptionData, now = new Date()) {
  const electrical = consumptionData?.value?.electrical;
  if (!electrical || typeof electrical !== 'object') {
    return null;
  }

  // 0-based index of the current month inside the "this year" half.
  const monthIndex = MONTHLY_THIS_YEAR_FROM + now.getMonth();
  let today = 0;
  let thisMonth = 0;
  let thisYear = 0;
  let found = false;

  for (const buckets of Object.values(electrical)) {
    if (!buckets || typeof buckets !== 'object') {
      continue;
    }
    found = true;
    today += sumFrom(buckets.d, DAILY_TODAY_FROM);
    thisYear += sumFrom(buckets.m, MONTHLY_THIS_YEAR_FROM);
    thisMonth += numberOr(Array.isArray(buckets.m) ? buckets.m[monthIndex] : null, 0);
  }

  if (!found) {
    return null;
  }
  // Daikin sends tenths of a kWh: keep three decimals so summing modes does
  // not drift into 0.30000000000000004.
  return { today: round(today), thisMonth: round(thisMonth), thisYear: round(thisYear) };
}

/**
 * Sum a bucket array from an index, treating the `null` Daikin uses for "not
 * measured yet" as zero.
 * @param {unknown} buckets the bucket array
 * @param {number} from the first index to count
 * @returns {number} the total
 */
function sumFrom(buckets, from) {
  if (!Array.isArray(buckets)) {
    return 0;
  }
  return buckets.slice(from).reduce((total, value) => total + numberOr(value, 0), 0);
}

/**
 * @param {number} value the value to round
 * @returns {number} the value with three decimals at most
 */
function round(value) {
  return Number(value.toFixed(3));
}

// Keys every management point carries: they describe the point itself, not
// something the unit can do, so they only add noise to the diagnostics.
const MANAGEMENT_POINT_KEYS = new Set([
  'embeddedId',
  'managementPointType',
  'managementPointSubType',
  'managementPointCategory',
]);

/**
 * List the characteristic names each management point of a gateway device
 * declares.
 * @param {Record<string, unknown>} gatewayDevice the gateway device
 * @returns {Record<string, Array<string>>} names, keyed by management point type
 */
function collectCharacteristics(gatewayDevice) {
  const managementPoints = Array.isArray(gatewayDevice.managementPoints)
    ? gatewayDevice.managementPoints
    : [];
  const byType = {};
  for (const point of managementPoints) {
    const type = point?.managementPointType;
    if (!type) {
      continue;
    }
    byType[type] = Object.keys(point)
      .filter((key) => !MANAGEMENT_POINT_KEYS.has(key))
      .sort();
  }
  return byType;
}

/**
 * Find a management point of a gateway device by type.
 * @param {Record<string, unknown>} gatewayDevice the gateway device
 * @param {string} type the management point type
 * @returns {Record<string, unknown>|undefined} the management point, when present
 */
function findManagementPoint(gatewayDevice, type) {
  const managementPoints = Array.isArray(gatewayDevice.managementPoints)
    ? gatewayDevice.managementPoints
    : [];
  return managementPoints.find((point) => point?.managementPointType === type);
}

/**
 * Normalize an on/off characteristic.
 * @param {Record<string, unknown>} characteristic the Daikin characteristic
 * @param {string} [embeddedId] the management point owning it, when it is not
 * the climate control one (the write has to be addressed there)
 * @returns {{ on: boolean, settable: boolean, embeddedId: string|undefined }|null} the toggle, or null when absent
 */
function toggle(characteristic, embeddedId) {
  const state = characteristic?.value;
  if (state !== 'on' && state !== 'off') {
    return null;
  }
  return { on: state === 'on', settable: characteristic.settable === true, embeddedId };
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
  const operationModes = fanControl?.value?.operationModes;
  if (!operationModes || typeof operationModes !== 'object') {
    return null;
  }

  // Daikin describes the fan PER operation mode, and the modes do not all
  // offer the same things — `dry` typically has no manual level at all, and
  // several modes carry no louver block. The catalog of Gladys features must
  // therefore come from the UNION of every mode: otherwise a device
  // discovered while the unit sat in Drying would permanently lose its speed
  // control. The state, on the other hand, only makes sense for the mode the
  // unit is actually running.
  const parsed = Object.fromEntries(
    Object.entries(operationModes).map(([mode, modeData]) => [mode, parseFanMode(modeData)]),
  );
  const blocks = Object.values(parsed).filter(Boolean);
  if (blocks.length === 0) {
    return null;
  }

  return {
    byMode: parsed,
    current: (operationMode ? parsed[operationMode] : null) ?? null,
    capabilities: unionFanCapabilities(blocks),
  };
}

/**
 * Normalize the fan block of ONE operation mode.
 * @param {Record<string, unknown>} modeData the per-mode fanControl entry
 * @returns {object|null} the normalized block, or null when the mode has no fan
 */
function parseFanMode(modeData) {
  if (!modeData || typeof modeData !== 'object') {
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
 * Everything the unit can do with its fan, whatever the operation mode: the
 * airflow modes it knows, the widest manual range it declares, and the louver
 * axes it can actually swing.
 * @param {Array<object>} blocks the per-mode fan blocks
 * @returns {{ speedModes: Array<string>, fixed: object|null, axes: Record<string, Array<string>> }} the union
 */
function unionFanCapabilities(blocks) {
  const speedModes = new Set();
  const axes = {};
  let fixed = null;

  for (const block of blocks) {
    for (const mode of block.speed?.modes ?? []) {
      speedModes.add(mode);
    }
    if (block.speed?.fixed) {
      // A range, never a current value: `value` belongs to the active mode.
      const { min, max, step } = block.speed.fixed;
      fixed = fixed
        ? {
            min: Math.min(fixed.min, min),
            max: Math.max(fixed.max, max),
            step: Math.min(fixed.step, step),
          }
        : { min, max, step };
    }
    for (const [axis, data] of Object.entries(block.direction ?? {})) {
      axes[axis] = [...new Set([...(axes[axis] ?? []), ...data.values])];
    }
  }

  return { speedModes: [...speedModes], fixed, axes };
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

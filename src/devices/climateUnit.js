// -----------------------------------------------------------------------------
// One Daikin climate unit <-> one Gladys device.
//
// Three jobs, kept apart on purpose:
//   - buildDevice() : the discovery payload (what the unit CAN do);
//   - buildStates() : the states to publish (what the unit IS doing);
//   - buildCommands(): the Daikin writes a user command translates into.
//
// The whole file is pure — it never touches the network — so the mapping is
// testable against real Daikin payloads.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  AC_FAN_SPEED,
  AC_MODE,
  AC_SWING,
  clamp,
  fanSpeedToDaikin,
  fanSpeedToGladys,
  modeToDaikin,
  modeToGladys,
  roundToStep,
  supportedFanSpeeds,
  swingToDaikin,
  swingToGladys,
} from '../mapping.js';

// Gladys device type prefix, part of every external_id.
export const DEVICE_TYPE = 'climate';

// Feature keys, kept in one place so discovery, states and commands agree.
export const FEATURE = {
  POWER: 'power',
  MODE: 'mode',
  TARGET_TEMPERATURE: 'target-temperature',
  ROOM_TEMPERATURE: 'room-temperature',
  OUTDOOR_TEMPERATURE: 'outdoor-temperature',
  FAN_SPEED: 'fan-speed',
  SWING_HORIZONTAL: 'swing-horizontal',
  SWING_VERTICAL: 'swing-vertical',
};

// Feature types added in Gladys 4.84.3, absent from the SDK constants (see
// src/capabilities.js): declared as literals, published only when supported.
const AC_FAN_SPEED_TYPE = 'fan-speed';
const AC_SWING_HORIZONTAL_TYPE = 'swing-horizontal';
const AC_SWING_VERTICAL_TYPE = 'swing-vertical';

// Labels of the `supported_options`, stored by Gladys as the fallback text of
// an option it cannot translate.
const MODE_LABELS = {
  [AC_MODE.AUTO]: 'Auto',
  [AC_MODE.COOLING]: 'Cooling',
  [AC_MODE.HEATING]: 'Heating',
  [AC_MODE.DRYING]: 'Drying',
  [AC_MODE.FAN]: 'Fan only',
};

const FAN_SPEED_LABELS = {
  [AC_FAN_SPEED.AUTO]: 'Auto',
  [AC_FAN_SPEED.LOW]: 'Low',
  [AC_FAN_SPEED.LOW_MID]: 'Low-mid',
  [AC_FAN_SPEED.MID]: 'Mid',
  [AC_FAN_SPEED.MID_HIGH]: 'Mid-high',
  [AC_FAN_SPEED.HIGH]: 'High',
  [AC_FAN_SPEED.QUIET]: 'Quiet',
};

const SWING_LABELS = {
  [AC_SWING.OFF]: 'Off',
  [AC_SWING.SWING]: 'Swing',
};

/**
 * The external_id of the Gladys device backing a Daikin unit.
 * @param {object} gladys the SDK instance
 * @param {object} unit the normalized Daikin unit
 * @returns {string} the device external_id
 */
export function deviceExternalId(gladys, unit) {
  return gladys.externalIds(DEVICE_TYPE, unit.platformId).device;
}

/**
 * The external_id of one feature of a Daikin unit.
 * @param {object} gladys the SDK instance
 * @param {object} unit the normalized Daikin unit
 * @param {string} featureKey one of FEATURE
 * @returns {string} the feature external_id
 */
export function featureExternalId(gladys, unit, featureKey) {
  return gladys.externalIds(DEVICE_TYPE, unit.platformId).feature(featureKey);
}

/**
 * Recover the feature key out of a feature external_id.
 * @param {object} gladys the SDK instance
 * @param {object} unit the normalized Daikin unit
 * @param {string} externalId the feature external_id received in onSetValue
 * @returns {string|null} the feature key, or null when it is not ours
 */
export function featureKeyOf(gladys, unit, externalId) {
  const prefix = `${deviceExternalId(gladys, unit)}:`;
  return externalId.startsWith(prefix) ? externalId.slice(prefix.length) : null;
}

/**
 * The discovery payload of one unit: only the features the hardware really has
 * (a unit without louvers gets no swing feature, a heat pump driving a water
 * temperature gets no room setpoint...).
 * @param {object} gladys the SDK instance
 * @param {object} unit the normalized Daikin unit
 * @param {{ fanAndSwing: boolean }} capabilities what the Gladys instance accepts
 * @returns {object} the device to publish
 */
export function buildDevice(gladys, unit, capabilities) {
  const ids = gladys.externalIds(DEVICE_TYPE, unit.platformId);
  const features = [];

  features.push({
    name: 'On/Off',
    external_id: ids.feature(FEATURE.POWER),
    category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
    type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.BINARY,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  });

  const modes = supportedModes(unit);
  if (modes.length > 0) {
    features.push({
      name: 'Mode',
      external_id: ids.feature(FEATURE.MODE),
      category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
      type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.MODE,
      min: Math.min(...modes),
      max: Math.max(...modes),
      read_only: false,
      has_feedback: true,
      keep_history: true,
      supported_options: toSupportedOptions(modes, MODE_LABELS),
    });
  }

  const bounds = temperatureBounds(unit);
  if (bounds) {
    features.push({
      name: 'Target temperature',
      external_id: ids.feature(FEATURE.TARGET_TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
      type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: bounds.min,
      max: bounds.max,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  if (unit.roomTemperature !== null) {
    features.push({
      name: 'Room temperature',
      external_id: ids.feature(FEATURE.ROOM_TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: -50,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  if (unit.outdoorTemperature !== null) {
    features.push({
      name: 'Outdoor temperature',
      external_id: ids.feature(FEATURE.OUTDOOR_TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: -50,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  if (capabilities.fanAndSwing) {
    const fanSpeeds = supportedFanSpeeds(unit.fan?.speed);
    if (fanSpeeds.length > 0) {
      features.push({
        name: 'Fan speed',
        external_id: ids.feature(FEATURE.FAN_SPEED),
        category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
        type: AC_FAN_SPEED_TYPE,
        min: Math.min(...fanSpeeds),
        max: Math.max(...fanSpeeds),
        read_only: false,
        has_feedback: true,
        keep_history: true,
        supported_options: toSupportedOptions(fanSpeeds, FAN_SPEED_LABELS),
      });
    }

    for (const [axis, featureKey, featureType, name] of [
      ['horizontal', FEATURE.SWING_HORIZONTAL, AC_SWING_HORIZONTAL_TYPE, 'Horizontal swing'],
      ['vertical', FEATURE.SWING_VERTICAL, AC_SWING_VERTICAL_TYPE, 'Vertical swing'],
    ]) {
      const swings = supportedSwings(unit, axis);
      if (swings.length === 0) {
        continue;
      }
      features.push({
        name,
        external_id: ids.feature(featureKey),
        category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
        type: featureType,
        min: Math.min(...swings),
        max: Math.max(...swings),
        read_only: false,
        has_feedback: true,
        keep_history: true,
        supported_options: toSupportedOptions(swings, SWING_LABELS),
      });
    }
  }

  return {
    name: unit.name,
    external_id: ids.device,
    features,
    // Technical data of the integration, silently refreshed on every
    // re-publish (a unit renamed in the Onecta app, a firmware upgrade...).
    params: [
      { name: 'daikin_device_id', value: String(unit.deviceId) },
      { name: 'daikin_embedded_id', value: String(unit.embeddedId) },
      { name: 'daikin_model', value: String(unit.model ?? '') },
    ],
  };
}

/**
 * The states to publish for one unit, skipping what cannot be read (a value
 * Daikin reports in a vocabulary Gladys has no word for is left untouched
 * rather than published wrong).
 * @param {object} gladys the SDK instance
 * @param {object} unit the normalized Daikin unit
 * @param {{ fanAndSwing: boolean }} capabilities what the Gladys instance accepts
 * @returns {Array<{ device_feature_external_id: string, state: number }>} the batch to publish
 */
export function buildStates(gladys, unit, capabilities) {
  const ids = gladys.externalIds(DEVICE_TYPE, unit.platformId);
  const states = [];
  const push = (featureKey, state) => {
    if (state !== null && state !== undefined) {
      states.push({ device_feature_external_id: ids.feature(featureKey), state });
    }
  };

  if (unit.power !== null) {
    push(FEATURE.POWER, unit.power === 'on' ? 1 : 0);
  }
  push(FEATURE.MODE, modeToGladys(unit.operationMode));
  push(FEATURE.TARGET_TEMPERATURE, unit.setpoint ? unit.setpoint.value : null);
  push(FEATURE.ROOM_TEMPERATURE, unit.roomTemperature);
  push(FEATURE.OUTDOOR_TEMPERATURE, unit.outdoorTemperature);

  if (capabilities.fanAndSwing) {
    push(FEATURE.FAN_SPEED, fanSpeedToGladys(unit.fan?.speed));
    push(FEATURE.SWING_HORIZONTAL, swingToGladys(unit.fan?.direction?.horizontal?.value));
    push(FEATURE.SWING_VERTICAL, swingToGladys(unit.fan?.direction?.vertical?.value));
  }

  return states;
}

/**
 * Translate a user command into the Daikin writes it takes, and into the state
 * to publish back so the dashboard reflects the change immediately (the Daikin
 * cloud serves the previous values for a few seconds after a write).
 * @param {object} unit the normalized Daikin unit
 * @param {string} featureKey the feature the user acted on
 * @param {number} value the requested value
 * @returns {{ writes: Array<object>, state: number }} the writes to send and the state to publish
 */
export function buildCommands(unit, featureKey, value) {
  switch (featureKey) {
    case FEATURE.POWER: {
      const on = Number(value) === 1;
      return {
        writes: [{ characteristic: 'onOffMode', value: on ? 'on' : 'off' }],
        state: on ? 1 : 0,
      };
    }

    case FEATURE.MODE: {
      const daikinMode = modeToDaikin(Number(value));
      if (!daikinMode) {
        throw new Error(`Unsupported air conditioning mode: ${value}`);
      }
      if (unit.operationModes.length > 0 && !unit.operationModes.includes(daikinMode)) {
        throw new Error(`This unit does not support the "${daikinMode}" mode`);
      }
      return {
        writes: [{ characteristic: 'operationMode', value: daikinMode }],
        state: Number(value),
      };
    }

    case FEATURE.TARGET_TEMPERATURE: {
      // The setpoint lives under the ACTIVE operation mode: switching from
      // cooling to heating targets another value, with another range.
      if (!unit.operationMode || !unit.setpoint) {
        throw new Error('This unit has no room temperature setpoint in its current mode');
      }
      const { min, max, step } = unit.setpoint;
      const temperature = roundToStep(Number(value), min, max, step);
      return {
        writes: [
          {
            characteristic: 'temperatureControl',
            path: `/operationModes/${unit.operationMode}/setpoints/roomTemperature`,
            value: temperature,
          },
        ],
        state: temperature,
      };
    }

    case FEATURE.FAN_SPEED: {
      const requested = clamp(Number(value), AC_FAN_SPEED.AUTO, AC_FAN_SPEED.TURBO);
      const target = fanSpeedToDaikin(requested, unit.fan?.speed);
      if (!target) {
        throw new Error(`This unit does not support the fan speed ${value} in its current mode`);
      }
      const writes = [
        {
          characteristic: 'fanControl',
          path: `/operationModes/${unit.operationMode}/fanSpeed/currentMode`,
          value: target.currentMode,
        },
      ];
      if (target.fixedValue !== null) {
        // Order matters: the level is only accepted once the mode is `fixed`.
        writes.push({
          characteristic: 'fanControl',
          path: `/operationModes/${unit.operationMode}/fanSpeed/modes/fixed`,
          value: target.fixedValue,
        });
      }
      return {
        writes,
        state:
          fanSpeedToGladys({ ...unit.fan.speed, ...toSpeedPreview(target, unit) }) ?? requested,
      };
    }

    case FEATURE.SWING_HORIZONTAL:
    case FEATURE.SWING_VERTICAL: {
      const axis = featureKey === FEATURE.SWING_HORIZONTAL ? 'horizontal' : 'vertical';
      const daikinDirection = swingToDaikin(Number(value));
      if (!daikinDirection || !unit.fan?.direction?.[axis]) {
        throw new Error(`This unit has no ${axis} louvers in its current mode`);
      }
      return {
        writes: [
          {
            characteristic: 'fanControl',
            path: `/operationModes/${unit.operationMode}/fanDirection/${axis}/currentMode`,
            value: daikinDirection,
          },
        ],
        state: Number(value),
      };
    }

    default:
      throw new Error(`Unknown feature: ${featureKey}`);
  }
}

/**
 * The fan speed block as it will look once the write lands, so the optimistic
 * state matches what the next poll will report.
 * @param {{ currentMode: string, fixedValue: number|null }} target the write about to be sent
 * @param {object} unit the normalized Daikin unit
 * @returns {object} the patched fan speed block
 */
function toSpeedPreview(target, unit) {
  return {
    currentMode: target.currentMode,
    fixed:
      target.fixedValue === null
        ? unit.fan.speed.fixed
        : { ...unit.fan.speed.fixed, value: target.fixedValue },
  };
}

/**
 * The Gladys modes a unit accepts, in the Gladys order.
 * @param {object} unit the normalized Daikin unit
 * @returns {Array<number>} the supported AC_MODE values
 */
function supportedModes(unit) {
  return unit.operationModes
    .map((mode) => modeToGladys(mode))
    .filter((mode) => mode !== null)
    .sort((a, b) => a - b);
}

/**
 * The Gladys swing values one axis of a unit accepts.
 * @param {object} unit the normalized Daikin unit
 * @param {string} axis 'horizontal' or 'vertical'
 * @returns {Array<number>} the supported AC_SWING values
 */
function supportedSwings(unit, axis) {
  const direction = unit.fan?.direction?.[axis];
  if (!direction) {
    return [];
  }
  const swings = direction.values
    .map((value) => swingToGladys(value))
    .filter((value) => value !== null);
  // A single choice is not a control: only offer the feature when the louvers
  // can actually be moved.
  return swings.length > 1 ? [...new Set(swings)].sort((a, b) => a - b) : [];
}

/**
 * Build the `supported_options` of a feature: the values this unit accepts,
 * in order, so the UI never offers a mode the hardware would refuse.
 * @param {Array<number>} values the supported values
 * @param {Record<number, string>} labels the fallback label of each value
 * @returns {Array<{ value: number, label: string, sort_order: number }>} the options
 */
function toSupportedOptions(values, labels) {
  return values.map((value, index) => ({
    value,
    label: labels[value] ?? String(value),
    sort_order: index,
  }));
}

/**
 * The min/max of the target temperature feature: the union of the ranges of
 * every operation mode, since Gladys carries one range per feature while
 * Daikin has one per mode. The exact per-mode range is still enforced when the
 * command is sent.
 * @param {object} unit the normalized Daikin unit
 * @returns {{ min: number, max: number }|null} the bounds, or null when the unit has no room setpoint
 */
function temperatureBounds(unit) {
  const setpoints = Object.values(unit.setpoints);
  if (setpoints.length === 0) {
    return null;
  }
  return {
    min: Math.min(...setpoints.map((setpoint) => setpoint.min)),
    max: Math.max(...setpoints.map((setpoint) => setpoint.max)),
  };
}

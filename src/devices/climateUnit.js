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
  AC_MODE,
  fanLevelToDaikin,
  fanLevelToGladys,
  fanModeToDaikin,
  fanModeToGladys,
  modeToDaikin,
  modeToGladys,
  rockSettingBounds,
  rockSettingToDaikin,
  rockSettingToGladys,
  roundToStep,
  supportedFanModes,
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
  FAN_MODE: 'fan-mode',
  FAN_LEVEL: 'fan-level',
  FAN_ROCK: 'fan-rock',
};

// The FAN category and its types exist since Gladys 4.79 but are absent from
// the SDK constants (v0.9): declared as literals, published only when the
// connected instance is recent enough (see src/capabilities.js).
const FAN_CATEGORY = 'fan';
const FAN_MODE_TYPE = 'mode';
const FAN_SPEED_TYPE = 'speed';
const FAN_ROCK_SETTING_TYPE = 'rock-setting';

// Labels of the `supported_options`, stored by Gladys as the fallback text of
// an option it cannot translate.
const MODE_LABELS = {
  [AC_MODE.AUTO]: 'Auto',
  [AC_MODE.COOLING]: 'Cooling',
  [AC_MODE.HEATING]: 'Heating',
  [AC_MODE.DRYING]: 'Drying',
  [AC_MODE.FAN]: 'Fan only',
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
 * @param {{ fanCategory: boolean, supportedOptions: boolean }} capabilities what the Gladys instance accepts
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
    // `min` and `max` are NOT NULL in the Gladys schema, for every feature —
    // a binary one included. Omitting them makes the device creation fail
    // with "t_device_feature.min cannot be null".
    min: 0,
    max: 1,
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
      // Restricting the list to the modes this unit has needs Gladys 4.84.3;
      // below that the interface simply offers all five.
      ...(capabilities.supportedOptions
        ? { supported_options: toSupportedOptions(modes, MODE_LABELS) }
        : {}),
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

  if (capabilities.fanCategory) {
    // Mode: how the unit picks its airflow (auto / quiet / manual). Worth a
    // feature only when there is a real choice to make.
    if (supportedFanModes(unit.fan?.speed).length > 1) {
      features.push({
        name: 'Fan mode',
        external_id: ids.feature(FEATURE.FAN_MODE),
        category: FAN_CATEGORY,
        type: FAN_MODE_TYPE,
        min: 0,
        max: 4,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      });
    }

    // Level: the manual speed. Gladys renders a slider bounded by min/max, so
    // the Daikin range goes in as is — no scaling, no rounding.
    const fixed = unit.fan?.speed?.fixed;
    if (fixed && fixed.max > fixed.min) {
      features.push({
        name: 'Fan speed',
        external_id: ids.feature(FEATURE.FAN_LEVEL),
        category: FAN_CATEGORY,
        type: FAN_SPEED_TYPE,
        min: fixed.min,
        max: fixed.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      });
    }

    // Oscillation: ONE feature for the two Daikin louver axes, thanks to the
    // bitmap encoding of rock-setting (bit 0 = left/right, bit 1 = up/down).
    const rock = rockSettingBounds(unit.fan?.direction);
    if (rock) {
      features.push({
        name: 'Oscillation',
        external_id: ids.feature(FEATURE.FAN_ROCK),
        category: FAN_CATEGORY,
        type: FAN_ROCK_SETTING_TYPE,
        // The Gladys select offers every enum value between min and max: the
        // maximum is what tells it which axes this unit has.
        min: rock.min,
        max: rock.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
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
 * @param {{ fanCategory: boolean, supportedOptions: boolean }} capabilities what the Gladys instance accepts
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

  if (capabilities.fanCategory) {
    push(FEATURE.FAN_MODE, fanModeToGladys(unit.fan?.speed));
    // Only meaningful while the unit runs on a manual level: reporting the
    // stored level while it is in auto would show a speed it is not using.
    push(FEATURE.FAN_LEVEL, fanLevelToGladys(unit.fan?.speed));
    push(FEATURE.FAN_ROCK, rockSettingToGladys(unit.fan?.direction));
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

    case FEATURE.FAN_MODE: {
      const daikinFanMode = fanModeToDaikin(Number(value), unit.fan?.speed);
      if (!daikinFanMode) {
        throw new Error(`This unit does not support that fan mode in its current operation mode`);
      }
      return {
        writes: [
          {
            characteristic: 'fanControl',
            path: `/operationModes/${unit.operationMode}/fanSpeed/currentMode`,
            value: daikinFanMode,
          },
        ],
        // Both MEDIUM and HIGH mean "manual" to Daikin, and it reports the
        // manual mode as MEDIUM: publish what the next read will confirm.
        state: fanModeToGladys({ ...unit.fan.speed, currentMode: daikinFanMode }),
      };
    }

    case FEATURE.FAN_LEVEL: {
      const level = fanLevelToDaikin(value, unit.fan?.speed);
      if (level === null) {
        throw new Error('This unit has no manual fan speed in its current mode');
      }
      // Setting a level means "run at this speed": the unit has to leave auto
      // or quiet for it to have any effect, and the mode must land first.
      return {
        writes: [
          {
            characteristic: 'fanControl',
            path: `/operationModes/${unit.operationMode}/fanSpeed/currentMode`,
            value: 'fixed',
          },
          {
            characteristic: 'fanControl',
            path: `/operationModes/${unit.operationMode}/fanSpeed/modes/fixed`,
            value: level,
          },
        ],
        state: level,
      };
    }

    case FEATURE.FAN_ROCK: {
      const axes = rockSettingToDaikin(Number(value), unit.fan?.direction);
      if (!axes) {
        throw new Error('This unit has no steerable louvers in its current mode');
      }
      return {
        writes: axes.map(({ axis, value: axisValue }) => ({
          characteristic: 'fanControl',
          path: `/operationModes/${unit.operationMode}/fanDirection/${axis}/currentMode`,
          value: axisValue,
        })),
        // An axis the unit does not have stays off, so the state we publish is
        // what the unit can actually reach — not blindly what was asked.
        state: rockSettingToGladys(previewDirection(unit, axes)),
      };
    }

    default:
      throw new Error(`Unknown feature: ${featureKey}`);
  }
}

/**
 * The louver block as it will look once the writes land, so the optimistic
 * state matches what the next read will report.
 * @param {object} unit the normalized Daikin unit
 * @param {Array<{ axis: string, value: string }>} axes the writes about to be sent
 * @returns {object} the patched direction block
 */
function previewDirection(unit, axes) {
  const preview = { ...unit.fan.direction };
  for (const { axis, value } of axes) {
    preview[axis] = { ...preview[axis], value };
  }
  return preview;
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

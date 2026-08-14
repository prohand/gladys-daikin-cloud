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
import { featureUuid } from './featureUuid.js';
import {
  AC_MODE,
  AC_SWING,
  fanLevelToDaikin,
  fanLevelToGladys,
  modeToDaikin,
  modeToGladys,
  rockSettingBounds,
  rockSettingToDaikin,
  rockSettingToGladys,
  roundToStep,
  supportedSwings,
  swingToDaikin,
  swingToGladys,
} from '../mapping.js';

// Gladys device type prefix, part of every external_id.
export const DEVICE_TYPE = 'climate';

// Feature keys, kept in one place so discovery, states and commands agree.
export const FEATURE = {
  POWER: 'power',
  POWER_SWITCH: 'power-switch',
  MODE: 'mode',
  TARGET_TEMPERATURE: 'target-temperature',
  ROOM_TEMPERATURE: 'room-temperature',
  OUTDOOR_TEMPERATURE: 'outdoor-temperature',
  FAN_LEVEL: 'fan-level',
  FAN_ROCK: 'fan-rock',
  SWING_HORIZONTAL: 'swing-horizontal',
  SWING_VERTICAL: 'swing-vertical',
  ENERGY_TODAY: 'energy-today',
  ENERGY_MONTH: 'energy-month',
  ENERGY_YEAR: 'energy-year',
  ENERGY_TODAY_CONSUMPTION: 'energy-today-consumption',
  ENERGY_TODAY_COST: 'energy-today-cost',
  POWERFUL: 'powerful',
  ECONO: 'econo',
  STREAMER: 'streamer',
  DRY_KEEP: 'dry-keep',
};

// The FAN category and its types exist since Gladys 4.79, the per-axis air
// conditioning swing since 4.84.3, and neither is in the SDK constants
// (v0.9): declared as literals, published only when the connected instance is
// recent enough (see src/capabilities.js).
const FAN_CATEGORY = 'fan';
const FAN_SPEED_TYPE = 'speed';
const FAN_ROCK_SETTING_TYPE = 'rock-setting';
const AC_SWING_HORIZONTAL_TYPE = 'swing-horizontal';
const AC_SWING_VERTICAL_TYPE = 'swing-vertical';

// Gladys reserves ONE feature per device for "is this appliance on?": the
// scene actions "Turn on/off the switches" and the assistants all resolve a
// device to the first (category `switch`, type `binary`) feature they find, and
// an air conditioning binary is invisible to them. The comfort toggles below
// are on/off characteristics too, so publishing them as switches made them
// compete for that slot — and a scene asking to switch the unit off silently
// switched its Powerful mode off instead, in whatever order the database
// returned the features. They are published under the `unknown` category
// (which Gladys renders as a plain on/off control, help-circle icon included)
// so the switch slot belongs to the unit's real power feature and to it alone.
const TOGGLE_CATEGORY = DEVICE_FEATURE_CATEGORIES.UNKNOWN;
const TOGGLE_TYPE = DEVICE_FEATURE_TYPES.SENSOR.BINARY;

// The Daikin comfort toggles, each an on/off characteristic of the climate
// control point — except "keep dry", which the indoor unit owns.
const TOGGLES = [
  { key: 'powerful', feature: 'POWERFUL', name: 'Powerful mode', characteristic: 'powerfulMode' },
  { key: 'econo', feature: 'ECONO', name: 'Econo mode', characteristic: 'econoMode' },
  { key: 'streamer', feature: 'STREAMER', name: 'Streamer mode', characteristic: 'streamerMode' },
  { key: 'dryKeep', feature: 'DRY_KEEP', name: 'Keep dry', characteristic: 'dryKeepSetting' },
];

// The consumption periods Daikin reports, and the features they feed.
const ENERGY_PERIODS = [
  { key: 'today', feature: 'ENERGY_TODAY', name: 'Energy today' },
  { key: 'thisMonth', feature: 'ENERGY_MONTH', name: 'Energy this month' },
  { key: 'thisYear', feature: 'ENERGY_YEAR', name: 'Energy this year' },
];

// Labels of the `supported_options`, stored by Gladys as the fallback text of
// an option it cannot translate.
const MODE_LABELS = {
  [AC_MODE.AUTO]: 'Auto',
  [AC_MODE.COOLING]: 'Cooling',
  [AC_MODE.HEATING]: 'Heating',
  [AC_MODE.DRYING]: 'Drying',
  [AC_MODE.FAN]: 'Fan only',
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
 * @param {{ fanCategory: boolean, supportedOptions: boolean, acSwing: boolean, energyMonitoring: boolean }} capabilities what the Gladys instance accepts
 * @param {Map<string, string>|null} [knownFeatureIds] the ids Gladys already stores, by feature external_id, or null when they could not be read
 * @returns {object} the device to publish
 */
export function buildDevice(gladys, unit, capabilities, knownFeatureIds = null) {
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

  // The SAME on/off, a second time, under the category Gladys looks up when a
  // scene says "turn off the switches" (`switch` + `binary`, the first match
  // wins). The air conditioning binary above is what the climate UI, HomeKit
  // and the mode logic read, and it cannot carry that role too — so the unit
  // gets an explicit switch handle rather than letting a comfort toggle be
  // mistaken for its power. No history: the same signal is already historised
  // by the feature above, this one is a control handle.
  features.push({
    name: 'On/Off (switch)',
    external_id: ids.feature(FEATURE.POWER_SWITCH),
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: false,
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

  // Everything below is built from `fan.capabilities`, the UNION over every
  // operation mode — never from the mode the unit happens to run right now.
  // Daikin drops the manual level in Drying and the louvers in several modes,
  // so reading the active mode would make the controls appear and disappear
  // depending on when the device was discovered.
  const fanCapabilities = unit.fan?.capabilities;

  if (capabilities.fanCategory) {
    // Level: the manual speed. Gladys renders a slider bounded by min/max, so
    // the Daikin range goes in as is — no scaling, no rounding.
    const fixed = fanCapabilities?.fixed;
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
  }

  // Louvers. One feature per axis when Gladys can store them — that is how the
  // Onecta app presents them, and how a scene can steer one axis alone. Older
  // instances fall back to the single oscillation bitmap of the FAN category.
  if (capabilities.acSwing) {
    for (const [axis, featureKey, featureType, name] of [
      ['horizontal', FEATURE.SWING_HORIZONTAL, AC_SWING_HORIZONTAL_TYPE, 'Horizontal airflow'],
      ['vertical', FEATURE.SWING_VERTICAL, AC_SWING_VERTICAL_TYPE, 'Vertical airflow'],
    ]) {
      const swings = supportedSwings(fanCapabilities, axis);
      if (swings.length < 2) {
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
  } else if (capabilities.fanCategory) {
    const rock = rockSettingBounds(fanCapabilities);
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

  // Electrical consumption. Daikin reports it as period totals that RESET —
  // today's counter goes back to zero at midnight — so these are plain
  // sensors, not the ever-growing index of an electricity meter.
  for (const { key, feature, name } of ENERGY_PERIODS) {
    if (unit.energy?.[key] === undefined || unit.energy?.[key] === null) {
      continue;
    }
    features.push({
      name,
      external_id: ids.feature(FEATURE[feature]),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  // The Gladys energy monitoring hangs off the counter of the DAY, and off
  // that one only: the core derives nothing by itself, an integration
  // publishes the "30 minutes consumption"/"30 minutes cost" pair and links it
  // with `energy_parent_id`, then a scheduled job fills the consumption from
  // the difference between two readings of the parent. Attaching the pair to
  // the monthly or the yearly counter too would count the same kWh twice in
  // the dashboard — see CLAUDE.md for why "today" is the one that carries it.
  const indexFeature = features.find(
    (feature) => feature.external_id === ids.feature(FEATURE.ENERGY_TODAY),
  );
  // `knownFeatureIds` being null means the ids Gladys holds could not be read.
  // The pair is then left out entirely rather than published against ids that
  // may already belong to something: it comes back on the next publish.
  if (capabilities.energyMonitoring && indexFeature && knownFeatureIds) {
    const consumptionExternalId = ids.feature(FEATURE.ENERGY_TODAY_CONSUMPTION);
    // A feature Gladys already stores keeps the id Gladys gave it: publishing
    // another one would rewrite the primary key its states hang on. Only a
    // feature Gladys has never seen carries the derived id — and the index has
    // to carry one, because its children point at it by id and nothing else.
    if (!knownFeatureIds.has(indexFeature.external_id)) {
      indexFeature.id = featureUuid(indexFeature.external_id);
    }
    // `energy_parent_id` is deliberately absent from the index feature: it is
    // the user who parents it to their main meter in Settings -> Energy, and
    // sending the key on every publish — even as null — would undo that.
    features.push({
      name: 'Energy today (consumption)',
      external_id: consumptionExternalId,
      ...(knownFeatureIds.has(consumptionExternalId)
        ? {}
        : { id: featureUuid(consumptionExternalId) }),
      energy_parent_id: featureIdOf(indexFeature.external_id, knownFeatureIds),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      // The bounds of the core's own derived features. These are written by
      // Gladys, not by this integration: narrowing them is not our call.
      max: 100000000000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
    features.push({
      name: 'Energy today (cost)',
      external_id: ids.feature(FEATURE.ENERGY_TODAY_COST),
      // The cost hangs off the consumption, not off the index: that is the
      // chain the core walks to price a 30-minute window.
      energy_parent_id: featureIdOf(consumptionExternalId, knownFeatureIds),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION_COST,
      unit: DEVICE_FEATURE_UNITS.EURO,
      min: 0,
      max: 100000000000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  // The comfort toggles. Daikin reports some of them read-only depending on
  // the model and the firmware ("keep dry" usually is): the feature follows
  // what the unit says rather than offering a switch that would be refused.
  for (const { key, feature, name } of TOGGLES) {
    const state = unit.toggles?.[key];
    if (!state) {
      continue;
    }
    features.push({
      name,
      external_id: ids.feature(FEATURE[feature]),
      category: TOGGLE_CATEGORY,
      type: TOGGLE_TYPE,
      min: 0,
      max: 1,
      read_only: !state.settable,
      has_feedback: state.settable,
      keep_history: true,
    });
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
 * The id a feature has (or will have) in Gladys: the one Gladys already stores
 * for it, the derived one when Gladys has never seen it.
 * @param {string} externalId the feature external_id
 * @param {Map<string, string>} knownFeatureIds the ids Gladys already stores
 * @returns {string} the feature id to point `energy_parent_id` at
 */
function featureIdOf(externalId, knownFeatureIds) {
  return knownFeatureIds.get(externalId) ?? featureUuid(externalId);
}

/**
 * The states to publish for one unit, skipping what cannot be read (a value
 * Daikin reports in a vocabulary Gladys has no word for is left untouched
 * rather than published wrong).
 * @param {object} gladys the SDK instance
 * @param {object} unit the normalized Daikin unit
 * @param {{ fanCategory: boolean, supportedOptions: boolean, acSwing: boolean }} capabilities what the Gladys instance accepts
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
    // Both faces of the same characteristic: the air conditioning one for the
    // climate UI, the switch one for the scenes and the assistants.
    push(FEATURE.POWER, unit.power === 'on' ? 1 : 0);
    push(FEATURE.POWER_SWITCH, unit.power === 'on' ? 1 : 0);
  }
  push(FEATURE.MODE, modeToGladys(unit.operationMode));
  push(FEATURE.TARGET_TEMPERATURE, unit.setpoint ? unit.setpoint.value : null);
  push(FEATURE.ROOM_TEMPERATURE, unit.roomTemperature);
  push(FEATURE.OUTDOOR_TEMPERATURE, unit.outdoorTemperature);

  // The STATE, unlike the catalog, comes from the operation mode the unit is
  // actually running: that is the only fan block that describes what it does.
  const current = unit.fan?.current;

  if (capabilities.fanCategory) {
    // Only meaningful while the unit runs on a manual level: reporting the
    // stored level while it is in auto would show a speed it is not using.
    push(FEATURE.FAN_LEVEL, fanLevelToGladys(current?.speed));
  }

  if (capabilities.acSwing) {
    push(FEATURE.SWING_HORIZONTAL, swingToGladys(current?.direction?.horizontal?.value));
    push(FEATURE.SWING_VERTICAL, swingToGladys(current?.direction?.vertical?.value));
  } else if (capabilities.fanCategory) {
    push(FEATURE.FAN_ROCK, rockSettingToGladys(current?.direction));
  }

  for (const { key, feature } of ENERGY_PERIODS) {
    push(FEATURE[feature], unit.energy?.[key] ?? null);
  }

  for (const { key, feature } of TOGGLES) {
    const state = unit.toggles?.[key];
    if (state) {
      push(FEATURE[feature], state.on ? 1 : 0);
    }
  }

  return states;
}

/**
 * Translate a user command into the Daikin writes it takes, and into the states
 * to publish back so the dashboard reflects the change immediately (the Daikin
 * cloud serves the previous values for a few seconds after a write).
 *
 * Several features can describe the same characteristic — the unit's power is
 * published both as an air conditioning binary and as a switch — so a command
 * answers with a LIST of states: publishing only the one the user touched
 * would leave its twin showing the opposite value until the next refresh.
 * @param {object} unit the normalized Daikin unit
 * @param {string} featureKey the feature the user acted on
 * @param {number} value the requested value
 * @returns {{ writes: Array<object>, states: Array<{ featureKey: string, state: number }> }} the writes to send and the states to publish
 */
export function buildCommands(unit, featureKey, value) {
  switch (featureKey) {
    case FEATURE.POWER:
    case FEATURE.POWER_SWITCH: {
      const on = Number(value) === 1;
      return {
        writes: [{ characteristic: 'onOffMode', value: on ? 'on' : 'off' }],
        states: [
          { featureKey: FEATURE.POWER, state: on ? 1 : 0 },
          { featureKey: FEATURE.POWER_SWITCH, state: on ? 1 : 0 },
        ],
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
        states: [{ featureKey, state: Number(value) }],
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
        states: [{ featureKey, state: temperature }],
      };
    }

    case FEATURE.FAN_LEVEL: {
      const level = fanLevelToDaikin(value, unit.fan?.current?.speed);
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
        states: [{ featureKey, state: level }],
      };
    }

    case FEATURE.FAN_ROCK: {
      const axes = rockSettingToDaikin(Number(value), unit.fan?.current?.direction);
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
        states: [{ featureKey, state: rockSettingToGladys(previewDirection(unit, axes)) }],
      };
    }

    case FEATURE.SWING_HORIZONTAL:
    case FEATURE.SWING_VERTICAL: {
      const axis = featureKey === FEATURE.SWING_HORIZONTAL ? 'horizontal' : 'vertical';
      const daikinDirection = swingToDaikin(Number(value));
      const axisData = unit.fan?.current?.direction?.[axis];
      if (!daikinDirection || !axisData) {
        throw new Error(`This unit has no ${axis} louvers in its current mode`);
      }
      if (axisData.values.length > 0 && !axisData.values.includes(daikinDirection)) {
        throw new Error(`This unit cannot set its ${axis} louvers to that position right now`);
      }
      return {
        writes: [
          {
            characteristic: 'fanControl',
            path: `/operationModes/${unit.operationMode}/fanDirection/${axis}/currentMode`,
            value: daikinDirection,
          },
        ],
        states: [{ featureKey, state: Number(value) }],
      };
    }

    case FEATURE.POWERFUL:
    case FEATURE.ECONO:
    case FEATURE.STREAMER:
    case FEATURE.DRY_KEEP: {
      const toggle = TOGGLES.find(({ feature }) => FEATURE[feature] === featureKey);
      const state = unit.toggles?.[toggle.key];
      if (!state) {
        throw new Error(`This unit has no ${toggle.name.toLowerCase()}`);
      }
      if (!state.settable) {
        throw new Error(`${toggle.name} is read-only on this unit`);
      }
      const on = Number(value) === 1;
      return {
        writes: [
          {
            characteristic: toggle.characteristic,
            value: on ? 'on' : 'off',
            // "Keep dry" belongs to the indoor unit, not the climate control
            // point: the write has to be addressed to its own management point.
            ...(state.embeddedId ? { embeddedId: state.embeddedId } : {}),
          },
        ],
        states: [{ featureKey, state: on ? 1 : 0 }],
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
  const preview = { ...unit.fan.current.direction };
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

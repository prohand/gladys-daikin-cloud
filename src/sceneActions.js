// -----------------------------------------------------------------------------
// Scene actions: operations a Gladys 5.1 scene can run, with a result.
//
// A scene can already drive every device feature one by one, so an action here
// earns its place only when it does something the features cannot:
//
//   - `set_climate` applies a whole setting in ONE card, in the order Daikin
//     needs. The setpoint and the fan speed live under the operation mode, so
//     a scene that sets 21 °C and then switches to Heating has written the
//     COOLING setpoint — the order of two separate cards decides what the unit
//     does. Here the mode always lands first. Values the unit already has are
//     skipped: every write costs one call of a 200-a-day quota.
//   - `read_consumption` answers with numbers Gladys does not store: yesterday
//     and last month are Daikin buckets, not device features.
//   - `refresh_account` forces a read before a scene checks a condition, and
//     reports what is left of the quota.
//
// Everything is validated BEFORE the first write: a mode the unit does not
// have must fail the action, not leave the unit switched on in its old mode.
//
// Pure: the writes go through the `sendCommand` the caller passes in (the
// same path as a command from the dashboard), so this file never touches the
// network.
// -----------------------------------------------------------------------------

import { FEATURE } from './devices/index.js';
import { fanLevelToDaikin, modeToGladys, roundToStep } from './mapping.js';

// The keys the scenes store: never renamed once published.
export const SCENE_ACTION = {
  SET_CLIMATE: 'set_climate',
  READ_CONSUMPTION: 'read_consumption',
  REFRESH_ACCOUNT: 'refresh_account',
};

// The mode field offers snake_case values (the manifest convention) for the
// Daikin operation modes Gladys has a word for.
const MODE_FIELD_TO_DAIKIN = {
  auto: 'auto',
  cooling: 'cooling',
  heating: 'heating',
  dry: 'dry',
  fan_only: 'fanOnly',
};
// The option values of the `mode` field, besides `unchanged`.
export const SET_CLIMATE_MODES = Object.keys(MODE_FIELD_TO_DAIKIN);
const DAIKIN_MODE_TO_FIELD = Object.fromEntries(
  Object.entries(MODE_FIELD_TO_DAIKIN).map(([field, daikin]) => [daikin, field]),
);

/**
 * Apply a whole climate setting to a unit, skipping what it already does.
 * @param {object} unit the normalized Daikin unit, updated by `sendCommand` as the writes land
 * @param {{ power?: string, mode?: string, temperature?: number|string|null, fan_speed?: number|string|null }} fields the resolved scene fields
 * @param {(featureKey: string, value: number) => Promise<void>} sendCommand sends one feature command and updates the snapshot
 * @returns {Promise<{ power: string|null, mode: string|null, temperature: number|null, commands_sent: number }>} what the unit is set to now
 */
export async function setClimate(unit, fields, sendCommand) {
  const power = ['on', 'off', 'unchanged'].includes(fields.power) ? fields.power : 'on';
  const mode = readMode(fields.mode);
  const temperature = readNumber(fields.temperature, 'temperature');
  const fanSpeed = readNumber(fields.fan_speed, 'fan_speed');

  if (!unit.online) {
    throw new Error(`${unit.name} is offline, Daikin cannot reach it right now`);
  }

  let sent = 0;
  const send = async (featureKey, value) => {
    await sendCommand(featureKey, value);
    sent += 1;
  };

  // Switching off is the whole instruction: nothing else is sent to a unit
  // that is being stopped.
  if (power === 'off') {
    if (unit.power !== 'off') {
      await send(FEATURE.POWER, 0);
    }
    return outputsOf(unit, sent);
  }

  // Everything below targets the mode the unit WILL run: check it all first.
  const targetMode = mode ?? unit.operationMode;
  if (mode && unit.operationModes.length > 0 && !unit.operationModes.includes(mode)) {
    throw new Error(`${unit.name} does not support the "${DAIKIN_MODE_TO_FIELD[mode]}" mode`);
  }
  const setpoint = targetMode ? unit.setpoints[targetMode] : null;
  if (temperature !== null && !setpoint) {
    throw new Error(`${unit.name} has no room temperature setpoint in that mode`);
  }
  const fanSpeedBlock = targetMode ? unit.fan?.byMode?.[targetMode]?.speed : null;
  if (fanSpeed !== null && !fanSpeedBlock?.fixed) {
    throw new Error(`${unit.name} has no manual fan speed in that mode`);
  }

  if (power === 'on' && unit.power !== 'on') {
    await send(FEATURE.POWER, 1);
  }
  if (mode && mode !== unit.operationMode) {
    await send(FEATURE.MODE, modeToGladys(mode));
  }
  if (temperature !== null) {
    // The mode landed: `unit.setpoint` is now the one of the target mode.
    const { min, max, step, value } = unit.setpoint;
    if (roundToStep(temperature, min, max, step) !== value) {
      await send(FEATURE.TARGET_TEMPERATURE, temperature);
    }
  }
  if (fanSpeed !== null) {
    const speed = unit.fan.current.speed;
    const level = fanLevelToDaikin(fanSpeed, speed);
    if (speed.currentMode !== 'fixed' || speed.fixed.value !== level) {
      await send(FEATURE.FAN_LEVEL, fanSpeed);
    }
  }
  return outputsOf(unit, sent);
}

/**
 * The consumption of one unit, or of the whole account, in kWh.
 * @param {Array<object>} units the units to add up
 * @returns {{ today_kwh: number, yesterday_kwh: number, this_month_kwh: number, last_month_kwh: number, this_year_kwh: number, last_year_kwh: number }} the totals
 */
export function consumptionOutputs(units) {
  const measured = units.filter((unit) => unit.energy);
  if (measured.length === 0) {
    throw new Error('No Daikin unit reports its consumption');
  }
  const total = (key) =>
    Number(measured.reduce((sum, unit) => sum + unit.energy[key], 0).toFixed(3));
  return {
    today_kwh: total('today'),
    yesterday_kwh: total('yesterday'),
    this_month_kwh: total('thisMonth'),
    last_month_kwh: total('lastMonth'),
    this_year_kwh: total('thisYear'),
    last_year_kwh: total('lastYear'),
  };
}

/**
 * What the account looks like, for the scene that asked for a fresh read.
 * @param {Array<object>} units the units of the account
 * @returns {{ units_total: number, units_online: number, units_running: number }} the counts
 */
export function accountOutputs(units) {
  const online = units.filter((unit) => unit.online);
  return {
    units_total: units.length,
    units_online: online.length,
    units_running: online.filter((unit) => unit.power === 'on').length,
  };
}

/**
 * @param {object} unit the unit, after the writes
 * @param {number} sent how many commands were sent
 * @returns {{ power: string|null, mode: string|null, temperature: number|null, commands_sent: number }} the outputs of `set_climate`
 */
function outputsOf(unit, sent) {
  return {
    power: unit.power,
    mode: DAIKIN_MODE_TO_FIELD[unit.operationMode] ?? unit.operationMode ?? null,
    temperature: unit.setpoint?.value ?? null,
    commands_sent: sent,
  };
}

/**
 * @param {unknown} value the mode field
 * @returns {string|null} the Daikin mode, or null to keep the current one
 */
function readMode(value) {
  if (value === undefined || value === null || value === '' || value === 'unchanged') {
    return null;
  }
  const mode = MODE_FIELD_TO_DAIKIN[value];
  if (!mode) {
    throw new Error(`Unknown mode "${value}"`);
  }
  return mode;
}

/**
 * @param {unknown} value an optional number field
 * @param {string} name the field name, for the error
 * @returns {number|null} the number, or null when the field was left empty
 */
function readNumber(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`"${name}" must be a number, got "${value}"`);
  }
  return number;
}

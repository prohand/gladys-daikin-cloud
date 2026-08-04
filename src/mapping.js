// -----------------------------------------------------------------------------
// Daikin vocabulary <-> Gladys vocabulary.
//
// Gladys stores every device feature state as a NUMBER, and the air
// conditioning features use the enums of the core (`AC_MODE`, `AC_FAN_SPEED`,
// `AC_SWING_*`). Daikin uses strings ("cooling", "quiet", "swing"...) plus a
// numeric fan level whose range depends on the model.
//
// Everything in this file is pure: no network, no state — which is exactly why
// the tricky parts (fan level scaling both ways) can be unit tested.
// -----------------------------------------------------------------------------

// Mirrors of the Gladys core enums (server/utils/constants.js). The SDK does
// not export them, and hardcoding them here keeps the integration readable.
export const AC_MODE = {
  AUTO: 0,
  COOLING: 1,
  HEATING: 2,
  DRYING: 3,
  FAN: 4,
};

export const AC_FAN_SPEED = {
  AUTO: 0,
  LOW: 1,
  LOW_MID: 2,
  MID: 3,
  MID_HIGH: 4,
  HIGH: 5,
  QUIET: 6,
  TURBO: 7,
};

export const AC_SWING = {
  OFF: 0,
  SWING: 1,
};

// The five Gladys levels a Daikin "fixed" fan speed is spread over.
const FIXED_SPEED_LEVELS = [
  AC_FAN_SPEED.LOW,
  AC_FAN_SPEED.LOW_MID,
  AC_FAN_SPEED.MID,
  AC_FAN_SPEED.MID_HIGH,
  AC_FAN_SPEED.HIGH,
];

const MODE_TO_GLADYS = {
  auto: AC_MODE.AUTO,
  cooling: AC_MODE.COOLING,
  heating: AC_MODE.HEATING,
  dry: AC_MODE.DRYING,
  fanOnly: AC_MODE.FAN,
};

const MODE_TO_DAIKIN = invert(MODE_TO_GLADYS);

const SWING_TO_GLADYS = {
  stop: AC_SWING.OFF,
  swing: AC_SWING.SWING,
};

const SWING_TO_DAIKIN = invert(SWING_TO_GLADYS);

/**
 * @param {string|null} daikinMode the Daikin operation mode
 * @returns {number|null} the Gladys AC_MODE value, or null when unsupported
 * (Daikin also has `humidification`, `heatingDay`, `heatingNight`, which have
 * no equivalent in the Gladys air conditioning vocabulary)
 */
export function modeToGladys(daikinMode) {
  return MODE_TO_GLADYS[daikinMode] ?? null;
}

/**
 * @param {number} gladysMode the Gladys AC_MODE value
 * @returns {string|null} the Daikin operation mode, or null when unknown
 */
export function modeToDaikin(gladysMode) {
  return MODE_TO_DAIKIN[gladysMode] ?? null;
}

/**
 * @param {string|null} daikinDirection the Daikin fan direction mode
 * @returns {number|null} the Gladys AC_SWING value, or null when unsupported
 * (`windNice`, `fixed` and `floorHeatingAirflow` are Daikin-specific comfort
 * airflows with no Gladys counterpart)
 */
export function swingToGladys(daikinDirection) {
  return SWING_TO_GLADYS[daikinDirection] ?? null;
}

/**
 * @param {number} gladysSwing the Gladys AC_SWING value
 * @returns {string|null} the Daikin fan direction mode, or null when unknown
 */
export function swingToDaikin(gladysSwing) {
  return SWING_TO_DAIKIN[gladysSwing] ?? null;
}

/**
 * Read the current fan speed of a unit as a Gladys AC_FAN_SPEED value.
 *
 * Daikin answers with a mode (`auto`, `quiet`, `fixed`) and, for `fixed`, a
 * level inside a model-dependent range (1-5 on most split units, but 1-3 or
 * 1-9 exist). The level is spread over the five Gladys speeds so a unit with
 * three steps still reaches LOW / MID / HIGH.
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {number|null} the Gladys fan speed, or null when it cannot be read
 */
export function fanSpeedToGladys(speed) {
  if (!speed) {
    return null;
  }
  if (speed.currentMode === 'auto') {
    return AC_FAN_SPEED.AUTO;
  }
  if (speed.currentMode === 'quiet') {
    return AC_FAN_SPEED.QUIET;
  }
  if (speed.currentMode !== 'fixed' || !speed.fixed) {
    return null;
  }
  const { value, min, max } = speed.fixed;
  if (max <= min) {
    return AC_FAN_SPEED.MID;
  }
  const ratio = (clamp(value, min, max) - min) / (max - min);
  return FIXED_SPEED_LEVELS[Math.round(ratio * (FIXED_SPEED_LEVELS.length - 1))];
}

/**
 * Translate a Gladys fan speed into the Daikin writes it takes.
 *
 * TURBO has no Daikin equivalent (the manufacturer exposes it as a separate
 * "powerful" mode), so it is served as the fastest fixed speed.
 * @param {number} gladysSpeed the requested Gladys AC_FAN_SPEED value
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {{ currentMode: string, fixedValue: number|null }|null} what to write, or null when unsupported
 */
export function fanSpeedToDaikin(gladysSpeed, speed) {
  if (!speed) {
    return null;
  }
  const supports = (mode) => speed.modes.length === 0 || speed.modes.includes(mode);

  if (gladysSpeed === AC_FAN_SPEED.AUTO && supports('auto')) {
    return { currentMode: 'auto', fixedValue: null };
  }
  if (gladysSpeed === AC_FAN_SPEED.QUIET && supports('quiet')) {
    return { currentMode: 'quiet', fixedValue: null };
  }
  if (!supports('fixed') || !speed.fixed) {
    return null;
  }

  const { min, max, step } = speed.fixed;
  const index =
    gladysSpeed === AC_FAN_SPEED.TURBO
      ? FIXED_SPEED_LEVELS.length - 1
      : FIXED_SPEED_LEVELS.indexOf(gladysSpeed);
  if (index < 0) {
    return null;
  }
  const raw = min + (index / (FIXED_SPEED_LEVELS.length - 1)) * (max - min);
  return { currentMode: 'fixed', fixedValue: roundToStep(raw, min, max, step) };
}

/**
 * The Gladys fan speeds a given unit can actually reach — used to restrict the
 * options shown in the UI to what the hardware supports.
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {Array<number>} the supported Gladys AC_FAN_SPEED values
 */
export function supportedFanSpeeds(speed) {
  if (!speed) {
    return [];
  }
  const supported = [];
  if (speed.modes.includes('auto')) {
    supported.push(AC_FAN_SPEED.AUTO);
  }
  if (speed.modes.includes('fixed') && speed.fixed) {
    supported.push(...FIXED_SPEED_LEVELS);
  }
  if (speed.modes.includes('quiet')) {
    supported.push(AC_FAN_SPEED.QUIET);
  }
  return supported;
}

/**
 * @param {number} value the value to constrain
 * @param {number} min the lower bound
 * @param {number} max the upper bound
 * @returns {number} the value, inside the bounds
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Snap a value on the grid the device accepts (Daikin refuses a setpoint that
 * is not a multiple of its step, e.g. 21.3 on a 0.5 grid).
 * @param {number} value the requested value
 * @param {number} min the lower bound
 * @param {number} max the upper bound
 * @param {number} step the accepted increment
 * @returns {number} the value the device accepts
 */
export function roundToStep(value, min, max, step) {
  const bounded = clamp(value, min, max);
  if (!step || step <= 0) {
    return bounded;
  }
  const snapped = min + Math.round((bounded - min) / step) * step;
  // Floating point: 18 + 7 * 0.5 must stay 21.5, not 21.500000000000004.
  return Number(clamp(snapped, min, max).toFixed(4));
}

/**
 * @param {Record<string, number>} source the mapping to reverse
 * @returns {Record<number, string>} the reversed mapping
 */
function invert(source) {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [value, key]));
}

// -----------------------------------------------------------------------------
// Daikin vocabulary <-> Gladys vocabulary.
//
// Gladys stores every device feature state as a NUMBER, and each feature type
// has its own enum in the core (`AC_MODE`, `FAN_MODE`, `FAN_ROCK_SETTING`).
// Daikin uses strings ("cooling", "quiet", "swing"...) plus a numeric fan level
// whose range depends on the model.
//
// The fan lives in the FAN category rather than the air conditioning one: it
// exists since Gladys 4.79 (against 4.84.3 for the air conditioning fan speed
// and swing), and it is what the Gladys interface shows for an air
// conditioner — "Mode ventilateur", "Vitesse (niveau)", "Oscillation".
//
// Everything in this file is pure: no network, no state — which is exactly why
// the tricky parts (the louver bitmap both ways) can be unit tested.
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

export const FAN_MODE = {
  OFF: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  AUTO: 4,
};

// Bitmap, same encoding as the Matter FanControl RockSetting: bit 0 is the
// left/right movement, bit 1 the up/down one. Daikin drives its two louver
// axes separately, so a single Gladys feature covers both.
export const FAN_ROCK_SETTING = {
  OFF: 0,
  LEFT_RIGHT: 1,
  UP_DOWN: 2,
  LEFT_RIGHT_AND_UP_DOWN: 3,
};

const ROCK_HORIZONTAL_BIT = 1;
const ROCK_VERTICAL_BIT = 2;

const MODE_TO_GLADYS = {
  auto: AC_MODE.AUTO,
  cooling: AC_MODE.COOLING,
  heating: AC_MODE.HEATING,
  dry: AC_MODE.DRYING,
  fanOnly: AC_MODE.FAN,
};

const MODE_TO_DAIKIN = invert(MODE_TO_GLADYS);

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

// --- Fan mode: how the unit picks its airflow --------------------------------
// Daikin offers three: `auto`, `quiet`, and `fixed` (a manual level, driven by
// the separate speed feature). FAN_MODE has five slots and the Gladys select
// always shows all of them, so the two extra ones are absorbed rather than
// left to fail: HIGH behaves like MEDIUM (switch to manual), and OFF is the
// only one refused — a Daikin fan has no "off" of its own, the unit does.

/**
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {number|null} the Gladys FAN_MODE value, or null when unreadable
 */
export function fanModeToGladys(speed) {
  if (!speed) {
    return null;
  }
  if (speed.currentMode === 'auto') {
    return FAN_MODE.AUTO;
  }
  if (speed.currentMode === 'quiet') {
    return FAN_MODE.LOW;
  }
  return speed.currentMode === 'fixed' ? FAN_MODE.MEDIUM : null;
}

/**
 * @param {number} gladysMode the requested Gladys FAN_MODE value
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {string|null} the Daikin fan mode to write, or null when the unit
 * cannot do it
 */
export function fanModeToDaikin(gladysMode, speed) {
  if (!speed) {
    return null;
  }
  const supports = (mode) => speed.modes.length === 0 || speed.modes.includes(mode);

  if (gladysMode === FAN_MODE.AUTO) {
    return supports('auto') ? 'auto' : null;
  }
  if (gladysMode === FAN_MODE.LOW) {
    return supports('quiet') ? 'quiet' : null;
  }
  if (gladysMode === FAN_MODE.MEDIUM || gladysMode === FAN_MODE.HIGH) {
    return supports('fixed') ? 'fixed' : null;
  }
  // FAN_MODE.OFF: Daikin has no fan-off, turning the unit off is another
  // feature entirely — refuse rather than silently do something else.
  return null;
}

/**
 * The Gladys fan modes a unit can actually reach, used to decide whether the
 * feature is worth publishing at all.
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {Array<number>} the reachable FAN_MODE values
 */
export function supportedFanModes(speed) {
  if (!speed) {
    return [];
  }
  const modes = [];
  if (speed.modes.includes('quiet')) {
    modes.push(FAN_MODE.LOW);
  }
  if (speed.modes.includes('fixed')) {
    modes.push(FAN_MODE.MEDIUM);
  }
  if (speed.modes.includes('auto')) {
    modes.push(FAN_MODE.AUTO);
  }
  return modes;
}

// --- Fan level: the manual speed ---------------------------------------------
// The Gladys feature is a slider bounded by the feature's own min/max, so the
// Daikin level needs no scaling at all: the bounds ARE the ones the unit
// declares.

/**
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {number|null} the current manual level, or null when the unit is
 * not running on a manual level right now
 */
export function fanLevelToGladys(speed) {
  if (!speed?.fixed) {
    return null;
  }
  return speed.currentMode === 'fixed' ? speed.fixed.value : null;
}

/**
 * @param {number} level the requested level
 * @param {object|null} speed the normalized `fan.speed` block of the unit
 * @returns {number|null} the level the unit accepts, or null when it has none
 */
export function fanLevelToDaikin(level, speed) {
  if (!speed?.fixed) {
    return null;
  }
  const { min, max, step } = speed.fixed;
  return roundToStep(Number(level), min, max, step);
}

// --- Louvers: one bitmap for the two Daikin axes -----------------------------

/**
 * @param {object|null} direction the normalized `fan.direction` block
 * @returns {number|null} the Gladys FAN_ROCK_SETTING value, or null when the
 * unit has no louvers
 */
export function rockSettingToGladys(direction) {
  if (!direction) {
    return null;
  }
  let value = FAN_ROCK_SETTING.OFF;
  if (direction.horizontal?.value === 'swing') {
    value += ROCK_HORIZONTAL_BIT;
  }
  if (direction.vertical?.value === 'swing') {
    value += ROCK_VERTICAL_BIT;
  }
  return value;
}

/**
 * Translate a requested oscillation into the per-axis Daikin writes.
 * An axis the unit does not have is simply left out.
 * @param {number} gladysRock the requested FAN_ROCK_SETTING value
 * @param {object|null} direction the normalized `fan.direction` block
 * @returns {Array<{ axis: string, value: string }>|null} the writes, or null when there are no louvers
 */
export function rockSettingToDaikin(gladysRock, direction) {
  if (!direction) {
    return null;
  }
  const writes = [];
  const wanted = [
    ['horizontal', ROCK_HORIZONTAL_BIT],
    ['vertical', ROCK_VERTICAL_BIT],
  ];
  for (const [axis, bit] of wanted) {
    const axisData = direction[axis];
    if (!axisData) {
      continue;
    }
    const value = (gladysRock & bit) === bit ? 'swing' : 'stop';
    // Only write what the axis actually accepts: a Daikin comfort airflow
    // (windNice, floorHeatingAirflow) is not something we can request.
    if (axisData.values.length > 0 && !axisData.values.includes(value)) {
      continue;
    }
    writes.push({ axis, value });
  }
  return writes.length > 0 ? writes : null;
}

/**
 * The bounds of the oscillation feature: the Gladys select offers every enum
 * value between `min` and `max`, so the maximum encodes which axes exist.
 * @param {object|null} direction the normalized `fan.direction` block
 * @returns {{ min: number, max: number }|null} the bounds, or null when there is nothing to steer
 */
export function rockSettingBounds(direction) {
  const canSwing = (axis) => Boolean(direction?.[axis]?.values.includes('swing'));
  const horizontal = canSwing('horizontal');
  const vertical = canSwing('vertical');
  if (!horizontal && !vertical) {
    return null;
  }
  if (horizontal && vertical) {
    return { min: FAN_ROCK_SETTING.OFF, max: FAN_ROCK_SETTING.LEFT_RIGHT_AND_UP_DOWN };
  }
  return {
    min: FAN_ROCK_SETTING.OFF,
    max: horizontal ? FAN_ROCK_SETTING.LEFT_RIGHT : FAN_ROCK_SETTING.UP_DOWN,
  };
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

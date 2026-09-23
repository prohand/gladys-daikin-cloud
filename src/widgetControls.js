// -----------------------------------------------------------------------------
// The `daikin_controls` widget: the buttons of ONE setting of one unit.
//
// A widget is "read and tap": the core offers no slider and no select there,
// only buttons, four at most per content. A unit has more to set than four
// buttons hold, so each widget instance drives one setting, picked in its
// settings — power, setpoint, mode, fan, louvers or comfort modes — and the
// user places one widget per setting they want at hand. Every setting fits
// in four buttons, so a button always does exactly one thing. A first version
// walked all the settings in pages behind a "Next" button, next to the
// on/off; in use it read as a jumble (a "Fan only" MODE button next to "Next:
// Fan"), and was dropped.
//
// Nothing but buttons: the temperatures and the state are the `daikin_unit`
// widget's job, and repeating them here only crowded the card.
//
// Every button carries a widget `action`, never a `device_feature` value: the
// core drops the cached content as soon as an action is handled, so the next
// label is right at once. A `device_feature` button only nudges the widget,
// and the nudge is rate limited (one per 10 s): two quick taps on "+" would
// have sent the same absolute setpoint twice. The relative actions are
// therefore computed at tap time, from the snapshot the previous tap patched.
//
// Pure: the commands go through the same `sendCommand` as the dashboard, the
// scenes and the assistants.
// -----------------------------------------------------------------------------

import { FEATURE } from './devices/index.js';
import { fanLevelToDaikin, modeToGladys, rockSettingToGladys, roundToStep } from './mapping.js';

// The values of the `control` setting, stored by the dashboards: never
// renamed once published.
export const CONTROL = {
  POWER: 'power',
  SETPOINT: 'setpoint',
  MODE: 'mode',
  FAN: 'fan',
  SWING: 'swing',
  COMFORT: 'comfort',
};

export const MODE_LABELS = {
  auto: { en: 'Auto', fr: 'Auto' },
  cooling: { en: 'Cooling', fr: 'Froid' },
  heating: { en: 'Heating', fr: 'Chauffage' },
  dry: { en: 'Drying', fr: 'Déshumidification' },
  fanOnly: { en: 'Fan only', fr: 'Ventilation' },
};

export const TOGGLE_LABELS = {
  powerful: { en: 'Powerful', fr: 'Powerful' },
  econo: { en: 'Econo', fr: 'Econo' },
  streamer: { en: 'Streamer', fr: 'Streamer' },
  dryKeep: { en: 'Keep dry', fr: 'Maintien au sec' },
};

const MODE_ICONS = {
  auto: 'refresh-cw',
  cooling: 'cloud-snow',
  heating: 'sun',
  dry: 'droplet',
  fanOnly: 'wind',
};

const AXES = {
  horizontal: {
    feature: FEATURE.SWING_HORIZONTAL,
    start: { en: 'Swing left/right', fr: 'Balayer gauche/droite' },
    stop: { en: 'Stop left/right', fr: 'Figer gauche/droite' },
  },
  vertical: {
    feature: FEATURE.SWING_VERTICAL,
    start: { en: 'Swing up/down', fr: 'Balayer haut/bas' },
    stop: { en: 'Stop up/down', fr: 'Figer haut/bas' },
  },
};

const TOGGLE_FEATURES = {
  powerful: FEATURE.POWERFUL,
  econo: FEATURE.ECONO,
  streamer: FEATURE.STREAMER,
  dryKeep: FEATURE.DRY_KEEP,
};

const AT_LIMIT = {
  en: 'Already at the limit of this mode.',
  fr: 'Déjà à la limite de ce mode.',
};

const FULL_CATALOG = { fanCategory: true, acSwing: true };

/**
 * The buttons of one setting of the unit, as it is right now: none when the
 * unit cannot use that setting in its current mode (no manual fan level
 * while drying) or does not have it at all.
 * @param {object} unit the normalized Daikin unit (reachable)
 * @param {string} control one of CONTROL
 * @param {{ fanCategory: boolean, acSwing: boolean }} [capabilities] the catalog Gladys accepted
 * @returns {Array<object>} the button components, four at most
 */
export function controlButtons(unit, control, capabilities = FULL_CATALOG) {
  switch (control) {
    case CONTROL.POWER: {
      const on = unit.power === 'on';
      return [
        button(
          'power',
          on ? { en: 'Turn off', fr: 'Éteindre' } : { en: 'Turn on', fr: 'Allumer' },
          'power',
          { on: !on },
          on ? 'secondary' : 'primary',
        ),
      ];
    }

    case CONTROL.SETPOINT:
      return unit.setpoint?.settable
        ? [
            button('setpoint_down', { en: 'Setpoint −', fr: 'Consigne −' }, 'minus'),
            button('setpoint_up', { en: 'Setpoint +', fr: 'Consigne +' }, 'plus'),
          ]
        : [];

    case CONTROL.MODE:
      // One button per mode the unit can switch TO: Gladys knows five modes,
      // so leaving the active one out always fits the four buttons.
      return supportedModes(unit)
        .filter((mode) => mode !== unit.operationMode)
        .slice(0, 4)
        .map((mode) =>
          button(`mode_${snakeCase(mode)}`, MODE_LABELS[mode], MODE_ICONS[mode], { mode }),
        );

    case CONTROL.FAN:
      return capabilities.fanCategory && unit.fan?.current?.speed?.fixed
        ? [
            button('fan_down', { en: 'Fan −', fr: 'Ventilation −' }, 'minus'),
            button('fan_up', { en: 'Fan +', fr: 'Ventilation +' }, 'plus'),
          ]
        : [];

    case CONTROL.SWING:
      if (!capabilities.acSwing && !capabilities.fanCategory) {
        return [];
      }
      return steerableAxes(unit).map((axis) => {
        const swinging = unit.fan.current.direction[axis].value === 'swing';
        return button(
          `swing_${axis}`,
          swinging ? AXES[axis].stop : AXES[axis].start,
          'move',
          { on: !swinging },
          swinging ? 'secondary' : 'primary',
        );
      });

    case CONTROL.COMFORT:
      // Four comfort modes at most, and a read-only one gets no button.
      return Object.entries(unit.toggles ?? {})
        .filter(([, toggle]) => toggle?.settable)
        .map(([key, toggle]) => {
          const name = TOGGLE_LABELS[key];
          return button(
            `toggle_${key}`,
            toggle.on
              ? { en: `Turn ${name.en} off`, fr: `Couper ${name.fr}` }
              : { en: `Turn ${name.en} on`, fr: `Activer ${name.fr}` },
            'star',
            { on: !toggle.on },
            toggle.on ? 'secondary' : 'primary',
          );
        });

    default:
      return [];
  }
}

/**
 * What a tap on a widget button asks for, read against the unit as it is NOW
 * (the snapshot the previous tap patched), not as it was when the content was
 * built.
 * @param {object} unit the normalized Daikin unit
 * @param {string} actionKey the `action.key` of the button
 * @param {object} [params] the `action.params` of the button
 * @param {{ fanCategory: boolean, acSwing: boolean }} [capabilities] the catalog Gladys accepted
 * @returns {{ command: { featureKey: string, value: number } } | { message: object }} the command to send, or why there is nothing to send
 */
export function resolveControl(unit, actionKey, params = {}, capabilities = FULL_CATALOG) {
  switch (actionKey) {
    case 'power':
      return { command: { featureKey: FEATURE.POWER, value: params.on ? 1 : 0 } };

    case 'setpoint_down':
    case 'setpoint_up': {
      const setpoint = unit.setpoint;
      if (!setpoint?.settable) {
        throw new Error(`${unit.name} has no room temperature setpoint in its current mode`);
      }
      const direction = actionKey === 'setpoint_up' ? 1 : -1;
      const { value, min, max, step } = setpoint;
      const target = roundToStep(value + direction * (step || 0.5), min, max, step);
      return target === value
        ? { message: AT_LIMIT }
        : { command: { featureKey: FEATURE.TARGET_TEMPERATURE, value: target } };
    }

    case 'fan_down':
    case 'fan_up': {
      const speed = unit.fan?.current?.speed;
      if (!speed?.fixed) {
        throw new Error(`${unit.name} has no manual fan speed in its current mode`);
      }
      const direction = actionKey === 'fan_up' ? 1 : -1;
      const current = speed.fixed.value;
      const target = fanLevelToDaikin(current + direction * (speed.fixed.step || 1), speed);
      // From auto or quiet, the first tap already changes something: it sets
      // the unit on a manual level, even when that level is the stored one.
      return target === current && speed.currentMode === 'fixed'
        ? { message: AT_LIMIT }
        : { command: { featureKey: FEATURE.FAN_LEVEL, value: target } };
    }

    case 'swing_horizontal':
    case 'swing_vertical': {
      const axis = actionKey === 'swing_horizontal' ? 'horizontal' : 'vertical';
      if (!steerableAxes(unit).includes(axis)) {
        throw new Error(`${unit.name} has no ${axis} louvers in its current mode`);
      }
      if (capabilities.acSwing) {
        return { command: { featureKey: AXES[axis].feature, value: params.on ? 1 : 0 } };
      }
      // A Gladys without the per-axis features carries both axes in one
      // bitmap: the other axis keeps what it does.
      const direction = unit.fan.current.direction;
      const preview = {
        ...direction,
        [axis]: { ...direction[axis], value: params.on ? 'swing' : 'stop' },
      };
      return { command: { featureKey: FEATURE.FAN_ROCK, value: rockSettingToGladys(preview) } };
    }

    default: {
      if (actionKey.startsWith('mode_')) {
        if (!supportedModes(unit).includes(params.mode)) {
          throw new Error(`${unit.name} does not support the "${params.mode}" mode`);
        }
        return { command: { featureKey: FEATURE.MODE, value: modeToGladys(params.mode) } };
      }
      const toggleKey = actionKey.startsWith('toggle_') ? actionKey.slice('toggle_'.length) : null;
      if (toggleKey && TOGGLE_FEATURES[toggleKey]) {
        return { command: { featureKey: TOGGLE_FEATURES[toggleKey], value: params.on ? 1 : 0 } };
      }
      throw new Error(`Unknown widget action: ${actionKey}`);
    }
  }
}

/**
 * The operation modes of the unit Gladys has a word for, in Daikin's order.
 * @param {object} unit the normalized Daikin unit
 * @returns {Array<string>} the Daikin modes
 */
function supportedModes(unit) {
  return unit.operationModes.filter((mode) => modeToGladys(mode) !== null && MODE_LABELS[mode]);
}

/**
 * The louver axes the unit can both start and stop in its current mode.
 * @param {object} unit the normalized Daikin unit
 * @returns {Array<string>} 'horizontal' and/or 'vertical'
 */
function steerableAxes(unit) {
  const direction = unit.fan?.current?.direction;
  if (!direction) {
    return [];
  }
  return Object.keys(AXES).filter((axis) => {
    const values = direction[axis]?.values ?? [];
    return values.includes('swing') && values.includes('stop');
  });
}

/**
 * @param {string} name a camelCase Daikin name
 * @returns {string} the same name as an action key accepts it (`^[a-z0-9_]+$`)
 */
function snakeCase(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * @param {string} key the action key, unique within the content
 * @param {{ en: string, fr: string }} label what the button says
 * @param {string} icon a Feather icon name
 * @param {object} [params] what the tap carries back
 * @param {string} [style] `primary` or `secondary`
 * @returns {object} a button component
 */
function button(key, label, icon, params, style = 'secondary') {
  return {
    type: 'button',
    label,
    icon,
    style,
    action: params ? { key, params } : { key },
  };
}

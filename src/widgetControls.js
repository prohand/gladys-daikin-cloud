// -----------------------------------------------------------------------------
// The `daikin_controls` widget: one unit's settings, as pages of buttons.
//
// It is a widget of its own, next to `daikin_unit` rather than inside it: the
// core caps a content at eight components, and four buttons there pushed the
// unit widget's tiles and chart out.
//
// A widget is "read and tap": the core offers no slider and no select there,
// only buttons — four at most per content. A unit has far more to set than
// four buttons can hold (setpoint, mode, fan, louvers, comfort modes), so the
// widget shows ONE page at a time: two buttons for the page's setting, the
// unit's on/off, and a "Next" button that moves to the following page.
//
// Every button carries a widget `action`, never a `device_feature` value: the
// core drops the cached content as soon as an action is handled, so the next
// label is right at once. A `device_feature` button only nudges the widget,
// and the nudge is rate limited (one per 10 s): two quick taps on "+" would
// have sent the same absolute setpoint twice. The relative actions are
// therefore computed at tap time, from the snapshot the previous tap patched.
//
// Pages exist only for what the unit can do in its CURRENT mode — no fan page
// while drying — and a page that vanished falls back to the first one.
//
// Pure: the page to show is kept by the caller, and the commands go through
// the same `sendCommand` as the dashboard, the scenes and the assistants.
// -----------------------------------------------------------------------------

import { FEATURE } from './devices/index.js';
import { fanLevelToDaikin, modeToGladys, rockSettingToGladys, roundToStep } from './mapping.js';

export const CONTROL_PAGE = {
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

const PAGE_LABELS = {
  [CONTROL_PAGE.SETPOINT]: { en: 'Setpoint', fr: 'Consigne' },
  [CONTROL_PAGE.MODE]: { en: 'Mode', fr: 'Mode' },
  [CONTROL_PAGE.FAN]: { en: 'Fan', fr: 'Ventilation' },
  [CONTROL_PAGE.SWING]: { en: 'Louvers', fr: 'Balayage' },
  [CONTROL_PAGE.COMFORT]: { en: 'Comfort', fr: 'Confort' },
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

// Two setting buttons per page: with the on/off and "Next", the core's cap.
const BUTTONS_PER_PAGE = 2;

const AT_LIMIT = {
  en: 'Already at the limit of this mode.',
  fr: 'Déjà à la limite de ce mode.',
};

const FULL_CATALOG = { fanCategory: true, acSwing: true };

/**
 * The page to show: its name, its buttons, the on/off, and the way to the
 * next page.
 * @param {object} unit the normalized Daikin unit (reachable)
 * @param {string|undefined} page the page the user last moved to
 * @param {{ fanCategory: boolean, acSwing: boolean }} [capabilities] the catalog Gladys accepted
 * @returns {{ label: object|null, buttons: Array<object> }} the page name (null when the unit has no page) and the button components, four at most
 */
export function controlPanel(unit, page, capabilities = FULL_CATALOG) {
  const pages = controlPages(unit, capabilities);
  const index = Math.max(
    0,
    pages.findIndex((candidate) => candidate.key === page),
  );
  const current = pages[index];
  const buttons = current ? [...current.buttons] : [];

  const on = unit.power === 'on';
  buttons.push({
    type: 'button',
    label: on ? { en: 'Turn off', fr: 'Éteindre' } : { en: 'Turn on', fr: 'Allumer' },
    icon: 'power',
    style: on ? 'secondary' : 'primary',
    action: { key: 'power', params: { on: !on } },
  });

  if (pages.length > 1) {
    const next = pages[(index + 1) % pages.length];
    buttons.push({
      type: 'button',
      label: { en: `Next: ${next.label.en}`, fr: `Suivant : ${next.label.fr}` },
      icon: 'chevron-right',
      style: 'secondary',
      action: { key: 'next_page', params: { page: next.key } },
    });
  }
  return { label: current?.label ?? null, buttons };
}

/**
 * The pages this unit offers right now, in the order the user walks them.
 * @param {object} unit the normalized Daikin unit
 * @param {{ fanCategory: boolean, acSwing: boolean }} capabilities the catalog Gladys accepted
 * @returns {Array<{ key: string, label: object, buttons: Array<object> }>} the pages
 */
export function controlPages(unit, capabilities = FULL_CATALOG) {
  const pages = [];
  const page = (key, buttons, label = PAGE_LABELS[key]) => {
    if (buttons.length > 0) {
      pages.push({ key, label, buttons });
    }
  };

  if (unit.setpoint?.settable) {
    page(CONTROL_PAGE.SETPOINT, [
      button('setpoint_down', { en: 'Setpoint −', fr: 'Consigne −' }, 'minus'),
      button('setpoint_up', { en: 'Setpoint +', fr: 'Consigne +' }, 'plus'),
    ]);
  }

  const modes = supportedModes(unit);
  const at = modes.indexOf(unit.operationMode);
  if (modes.length > 1) {
    // Two neighbours in the cycle, or the only other mode once.
    const previous = modes[(at - 1 + modes.length) % modes.length];
    const next = modes[(at + 1) % modes.length];
    const targets = at === -1 ? modes.slice(0, 2) : [...new Set([previous, next])];
    page(
      CONTROL_PAGE.MODE,
      targets.map((mode, position) => {
        const back = position === 0 && targets.length > 1;
        return button(
          back ? 'mode_previous' : 'mode_next',
          MODE_LABELS[mode],
          back ? 'chevron-left' : 'chevron-right',
          { mode },
        );
      }),
    );
  }

  if (capabilities.fanCategory && unit.fan?.current?.speed?.fixed) {
    page(CONTROL_PAGE.FAN, [
      button('fan_down', { en: 'Fan −', fr: 'Ventilation −' }, 'minus'),
      button('fan_up', { en: 'Fan +', fr: 'Ventilation +' }, 'plus'),
    ]);
  }

  if (capabilities.acSwing || capabilities.fanCategory) {
    page(
      CONTROL_PAGE.SWING,
      steerableAxes(unit).map((axis) => {
        const swinging = unit.fan.current.direction[axis].value === 'swing';
        return button(
          `swing_${axis}`,
          swinging ? AXES[axis].stop : AXES[axis].start,
          'move',
          { on: !swinging },
          swinging ? 'secondary' : 'primary',
        );
      }),
    );
  }

  const toggles = Object.entries(unit.toggles ?? {}).filter(([, toggle]) => toggle?.settable);
  for (let start = 0; start < toggles.length; start += BUTTONS_PER_PAGE) {
    const chunk = toggles.slice(start, start + BUTTONS_PER_PAGE);
    // A unit with more comfort modes than a page holds gets a second page,
    // numbered: its content in words would not fit the 24 characters of the
    // "Next" button that names it.
    const number = start / BUTTONS_PER_PAGE + 1;
    const label =
      number === 1
        ? PAGE_LABELS[CONTROL_PAGE.COMFORT]
        : { en: `Comfort ${number}`, fr: `Confort ${number}` };
    page(
      number === 1 ? CONTROL_PAGE.COMFORT : `${CONTROL_PAGE.COMFORT}_${number}`,
      chunk.map(([key, toggle]) => {
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
      }),
      label,
    );
  }
  return pages;
}

/**
 * What a tap on a widget button asks for, read against the unit as it is NOW
 * (the snapshot the previous tap patched), not as it was when the content was
 * built.
 * @param {object} unit the normalized Daikin unit
 * @param {string} actionKey the `action.key` of the button
 * @param {object} [params] the `action.params` of the button
 * @param {{ fanCategory: boolean, acSwing: boolean }} [capabilities] the catalog Gladys accepted
 * @returns {{ page: string } | { command: { featureKey: string, value: number } } | { message: object }} a page to show, a command to send, or why there is nothing to send
 */
export function resolveControl(unit, actionKey, params = {}, capabilities = FULL_CATALOG) {
  switch (actionKey) {
    case 'next_page':
      return { page: String(params.page ?? '') };

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

    case 'mode_previous':
    case 'mode_next': {
      if (!supportedModes(unit).includes(params.mode)) {
        throw new Error(`${unit.name} does not support the "${params.mode}" mode`);
      }
      return { command: { featureKey: FEATURE.MODE, value: modeToGladys(params.mode) } };
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

// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1): what the integration shows beyond features.
//
// Gladys renders the widget; the integration only returns content in the
// core's declarative vocabulary (tiles, a chart, a status list, buttons). Two
// widgets, one per question a dashboard asks:
//
//   - `daikin_unit`: one unit at a glance. The temperatures and today's energy
//     are LIVE tiles bound to the device features — they move the instant a
//     state is published, with no pull. What no feature carries goes in the
//     status list (fan, comfort modes, reachability, in words) and the chart:
//     either the feature history, or today's two-hour consumption slots next
//     to yesterday's, which only Daikin's buckets hold.
//   - `daikin_account`: the whole account — which units run, the energy of the
//     day, the months of this year against last year's, and the one number
//     that governs this integration: the API calls left today.
//
// Every text is an `{ en, fr }` pair the core picks from, except the numbers
// woven into a sentence, which are formatted per language (22.5 / 22,5) and
// per unit system: a tile bound to a feature is converted by the core, an
// inline temperature is converted here.
//
// Nothing here costs an API call: the widgets read the snapshot of the store,
// and index.js nudges them after each refresh and each command.
//
// Pure: the content is built from the units, the SDK only carries it.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE, featureExternalId } from './devices/index.js';
import { QUOTA_LOW_THRESHOLD } from './sceneEvents.js';

// The keys the dashboards store: never renamed once published.
export const WIDGET = {
  UNIT: 'daikin_unit',
  ACCOUNT: 'daikin_account',
};

// What the unit widget charts, a setting of each instance.
export const UNIT_CHART = {
  TEMPERATURE: 'temperature',
  CONSUMPTION: 'consumption',
  NONE: 'none',
};

// The content only changes when the snapshot does, and every change nudges
// the widgets: the TTL is a safety net, not the refresh rate. The account
// widget ages faster because it says how old its last read is.
const UNIT_TTL_SECONDS = 300;
const ACCOUNT_TTL_SECONDS = 60;
const WAITING_TTL_SECONDS = 30;
const MAX_STATUS_ROWS = 10;
// Daikin's documented developer quota, when the headers have not said yet.
const DEFAULT_DAILY_QUOTA = 200;

const LANGUAGES = ['en', 'fr'];

const MODE_LABELS = {
  auto: { en: 'Auto', fr: 'Auto' },
  cooling: { en: 'Cooling', fr: 'Froid' },
  heating: { en: 'Heating', fr: 'Chauffage' },
  dry: { en: 'Drying', fr: 'Déshumidification' },
  fanOnly: { en: 'Fan only', fr: 'Ventilation' },
};

const TOGGLE_LABELS = {
  powerful: { en: 'Powerful', fr: 'Powerful' },
  econo: { en: 'Econo', fr: 'Econo' },
  streamer: { en: 'Streamer', fr: 'Streamer' },
  dryKeep: { en: 'Keep dry', fr: 'Maintien au sec' },
};

/**
 * The content of the `daikin_unit` widget.
 * @param {object} gladys the SDK instance (external ids only)
 * @param {object|undefined} unit the unit the widget instance is bound to, when found
 * @param {{ chart?: string, unitSystem?: string, now?: Date, ready?: boolean }} [options] the instance settings and the context
 * @returns {object} the widget content
 */
export function buildUnitWidget(gladys, unit, options = {}) {
  const { chart = UNIT_CHART.TEMPERATURE, now = new Date(), ready = true } = options;
  if (!unit) {
    return message(
      ready
        ? {
            en: 'This unit is no longer in the Daikin account. Pick another one in the widget settings.',
            fr: "Cette unité n'est plus dans le compte Daikin. Choisissez-en une autre dans les réglages du widget.",
          }
        : {
            en: 'Reading the Daikin account, this widget fills in a moment.',
            fr: 'Lecture du compte Daikin en cours, ce widget se remplit dans un instant.',
          },
      ready ? UNIT_TTL_SECONDS : WAITING_TTL_SECONDS,
    );
  }

  const feature = (key) => featureExternalId(gladys, unit, key);
  const components = [];

  // Live tiles: the core follows the published states on its own.
  if (unit.roomTemperature !== null) {
    components.push(tile(feature(FEATURE.ROOM_TEMPERATURE), 'thermometer', 'Room', 'Pièce'));
  }
  if (Object.keys(unit.setpoints).length > 0) {
    components.push(tile(feature(FEATURE.TARGET_TEMPERATURE), 'target', 'Setpoint', 'Consigne'));
  }
  if (unit.outdoorTemperature !== null) {
    components.push(tile(feature(FEATURE.OUTDOOR_TEMPERATURE), 'sun', 'Outdoor', 'Extérieur'));
  }
  if (unit.energy) {
    components.push(tile(feature(FEATURE.ENERGY_TODAY), 'zap', 'Today', "Aujourd'hui"));
  }

  if (!unit.online) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: {
        en: 'Unreachable: the values are the last ones known.',
        fr: 'Injoignable : les valeurs sont les dernières connues.',
      },
    });
  }

  const chartComponent =
    chart === UNIT_CHART.CONSUMPTION
      ? consumptionChart(unit, now)
      : chart === UNIT_CHART.NONE
        ? null
        : temperatureChart(unit, feature);
  if (chartComponent) {
    components.push(chartComponent);
  }

  components.push({ type: 'status', items: unitStatusItems(unit) });

  // Commands to an unreachable unit are refused by Daikin: no buttons then.
  if (unit.online) {
    components.push(
      {
        type: 'button',
        label: { en: 'Turn on', fr: 'Allumer' },
        icon: 'power',
        style: 'primary',
        device_feature: feature(FEATURE.POWER),
        value: 1,
      },
      {
        type: 'button',
        label: { en: 'Turn off', fr: 'Éteindre' },
        icon: 'power',
        style: 'secondary',
        device_feature: feature(FEATURE.POWER),
        value: 0,
      },
    );
  }

  return { ttl_seconds: UNIT_TTL_SECONDS, components };
}

/**
 * The content of the `daikin_account` widget.
 * @param {Array<object>} units the units of the account
 * @param {{ linked?: boolean, ready?: boolean, rateLimits?: object, lastRefreshAt?: number, unitSystem?: string, now?: Date }} [options] the context
 * @returns {object} the widget content
 */
export function buildAccountWidget(units, options = {}) {
  const {
    linked = true,
    ready = true,
    rateLimits = {},
    lastRefreshAt = 0,
    unitSystem = 'metric',
    now = new Date(),
  } = options;
  if (!linked) {
    return message(
      {
        en: 'No Daikin account linked yet: connect it in the integration configuration.',
        fr: "Aucun compte Daikin lié : connectez-le dans la configuration de l'intégration.",
      },
      ACCOUNT_TTL_SECONDS,
    );
  }
  if (!ready) {
    return message(
      {
        en: 'Reading the Daikin account, this widget fills in a moment.',
        fr: 'Lecture du compte Daikin en cours, ce widget se remplit dans un instant.',
      },
      WAITING_TTL_SECONDS,
    );
  }
  if (units.length === 0) {
    return message(
      {
        en: 'The Daikin account holds no air conditioner.',
        fr: 'Le compte Daikin ne contient aucun climatiseur.',
      },
      ACCOUNT_TTL_SECONDS,
    );
  }

  const components = [];
  const running = units.filter((unit) => unit.online && unit.power === 'on').length;
  components.push({
    type: 'value',
    value: `${running}/${units.length}`,
    label: { en: 'Units running', fr: 'Unités en marche' },
    icon: 'wind',
    color: running > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
  });

  const measured = units.filter((unit) => unit.energy);
  if (measured.length > 0) {
    components.push({
      type: 'value',
      value: round(
        measured.reduce((sum, unit) => sum + unit.energy.today, 0),
        1,
      ),
      unit: 'kWh',
      label: { en: 'Energy today', fr: 'Énergie du jour' },
      icon: 'zap',
    });
  }

  const { remainingDay, limitDay } = rateLimits;
  if (typeof remainingDay === 'number') {
    components.push({
      type: 'gauge',
      value: remainingDay,
      min: 0,
      max: Math.max(limitDay ?? DEFAULT_DAILY_QUOTA, remainingDay, 1),
      label: { en: 'API calls left', fr: 'Appels API restants' },
      color: quotaColor(remainingDay),
    });
  }

  if (lastRefreshAt > 0) {
    const minutes = Math.max(0, Math.floor((now.getTime() - lastRefreshAt) / 60_000));
    components.push({
      type: 'text',
      variant: 'caption',
      text:
        minutes === 0
          ? { en: 'Read from the Daikin cloud just now', fr: "Lu sur le cloud Daikin à l'instant" }
          : {
              en: `Read from the Daikin cloud ${minutes} min ago`,
              fr: `Lu sur le cloud Daikin il y a ${minutes} min`,
            },
    });
  }

  const chart = monthsChart(measured, now);
  if (chart) {
    components.push(chart);
  }

  components.push({
    type: 'status',
    items: units.slice(0, MAX_STATUS_ROWS).map((unit) => accountStatusItem(unit, unitSystem)),
  });

  return { ttl_seconds: ACCOUNT_TTL_SECONDS, components };
}

/**
 * The status rows of one unit: what the tiles and the chart do not say.
 * @param {object} unit the normalized Daikin unit
 * @returns {Array<object>} the rows
 */
function unitStatusItems(unit) {
  const items = [{ label: { en: 'State', fr: 'État' }, ...stateOf(unit) }];
  if (unit.operationMode) {
    items.push({
      label: { en: 'Mode', fr: 'Mode' },
      value: MODE_LABELS[unit.operationMode] ?? unit.operationMode,
      icon: 'sliders',
    });
  }
  const fan = fanLabel(unit.fan?.current?.speed);
  if (fan) {
    items.push({ label: { en: 'Fan', fr: 'Ventilation' }, value: fan, icon: 'wind' });
  }
  const swing = swingLabel(unit.fan?.current?.direction);
  if (swing) {
    items.push({ label: { en: 'Louvers', fr: 'Volets' }, value: swing, icon: 'move' });
  }
  const toggles = Object.entries(unit.toggles ?? {}).filter(([, toggle]) => toggle);
  if (toggles.length > 0) {
    const active = toggles.filter(([, toggle]) => toggle.on).map(([key]) => TOGGLE_LABELS[key]);
    items.push({
      label: { en: 'Comfort modes', fr: 'Modes confort' },
      value:
        active.length === 0
          ? { en: 'None', fr: 'Aucun' }
          : perLanguage((language) => active.map((label) => label[language]).join(', ')),
      icon: 'star',
      color: active.length > 0 ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
    });
  }
  return items;
}

/**
 * One row of the account status list: the unit, and what it is doing.
 * @param {object} unit the normalized Daikin unit
 * @param {string} unitSystem `metric` or `us`
 * @returns {object} the row
 */
function accountStatusItem(unit, unitSystem) {
  const state = stateOf(unit);
  if (!unit.online || unit.inErrorState || unit.power !== 'on') {
    return { label: unit.name, ...state };
  }
  const mode = MODE_LABELS[unit.operationMode] ?? {
    en: unit.operationMode ?? '—',
    fr: unit.operationMode ?? '—',
  };
  return {
    label: unit.name,
    value: perLanguage((language) => {
      const parts = [mode[language]];
      if (unit.roomTemperature !== null) {
        parts.push(formatTemperature(unit.roomTemperature, unitSystem, language));
      }
      return parts.join(' · ');
    }),
    color: state.color,
    icon: 'wind',
  };
}

/**
 * Reachability, fault and power, in the order they matter.
 * @param {object} unit the normalized Daikin unit
 * @returns {{ value: object, color: string }} the value and color of a status row
 */
function stateOf(unit) {
  if (!unit.online) {
    return { value: { en: 'Unreachable', fr: 'Injoignable' }, color: WIDGET_COLORS.DANGER };
  }
  if (unit.inErrorState) {
    return { value: { en: 'Error', fr: 'En erreur' }, color: WIDGET_COLORS.WARNING };
  }
  if (unit.power === 'on') {
    return { value: { en: 'Running', fr: 'En marche' }, color: WIDGET_COLORS.SUCCESS };
  }
  return { value: { en: 'Off', fr: 'Arrêtée' }, color: WIDGET_COLORS.NEUTRAL };
}

/**
 * @param {object|null} speed the fan speed block of the running mode
 * @returns {object|null} the fan setting in words
 */
function fanLabel(speed) {
  if (!speed?.currentMode) {
    return null;
  }
  if (speed.currentMode === 'fixed' && speed.fixed) {
    return { en: `Level ${speed.fixed.value}`, fr: `Niveau ${speed.fixed.value}` };
  }
  if (speed.currentMode === 'quiet') {
    return { en: 'Quiet', fr: 'Silencieux' };
  }
  if (speed.currentMode === 'auto') {
    return { en: 'Auto', fr: 'Auto' };
  }
  return { en: speed.currentMode, fr: speed.currentMode };
}

/**
 * @param {object|null} direction the louver block of the running mode
 * @returns {object|null} which axes swing, in words
 */
function swingLabel(direction) {
  if (!direction) {
    return null;
  }
  const horizontal = direction.horizontal?.value === 'swing';
  const vertical = direction.vertical?.value === 'swing';
  if (horizontal && vertical) {
    return { en: 'Swinging both ways', fr: 'Balayage 3D' };
  }
  if (horizontal) {
    return { en: 'Swinging left/right', fr: 'Balayage gauche/droite' };
  }
  if (vertical) {
    return { en: 'Swinging up/down', fr: 'Balayage haut/bas' };
  }
  return { en: 'Fixed', fr: 'Fixes' };
}

/**
 * The temperatures of the unit over the last day, from the core's own history.
 * @param {object} unit the normalized Daikin unit
 * @param {Function} feature `(key) => external_id`
 * @returns {object|null} the chart, or null when the unit measures nothing
 */
function temperatureChart(unit, feature) {
  const bound = [];
  if (unit.roomTemperature !== null) {
    bound.push(feature(FEATURE.ROOM_TEMPERATURE));
  }
  if (Object.keys(unit.setpoints).length > 0) {
    bound.push(feature(FEATURE.TARGET_TEMPERATURE));
  }
  if (unit.outdoorTemperature !== null) {
    bound.push(feature(FEATURE.OUTDOOR_TEMPERATURE));
  }
  if (bound.length === 0) {
    return null;
  }
  return {
    type: 'chart',
    chart_type: 'line',
    title: { en: 'Temperatures, last 24 h', fr: 'Températures, 24 h' },
    device_features: bound,
    interval: 'last-day',
  };
}

/**
 * Today's two-hour consumption slots, next to yesterday's on the same hours.
 * Gladys only ever stored the running total of the day: the slots are Daikin's.
 * @param {object} unit the normalized Daikin unit
 * @param {Date} now the current date
 * @returns {object|null} the chart, or null when the unit reports no consumption
 */
function consumptionChart(unit, now) {
  const slots = unit.energy?.slots;
  if (!slots) {
    return null;
  }
  const slotStart = (index) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), index * 2).toISOString();
  const today = slots.today
    .map((value, index) => ({ t: slotStart(index), v: value }))
    // The slots still to come are zeros, not measurements.
    .filter((_, index) => index * 2 <= now.getHours());
  const yesterday = slots.yesterday.map((value, index) => ({ t: slotStart(index), v: value }));
  return {
    type: 'chart',
    chart_type: 'bar',
    title: { en: 'Energy per 2 h', fr: 'Énergie par tranche de 2 h' },
    unit: 'kWh',
    series: [
      { name: { en: 'Today', fr: "Aujourd'hui" }, points: today },
      { name: { en: 'Yesterday', fr: 'Hier' }, points: yesterday },
    ],
    now_marker: true,
  };
}

/**
 * The months of this year next to the same months of last year, account-wide.
 * @param {Array<object>} units the units that report a consumption
 * @param {Date} now the current date
 * @returns {object|null} the chart, or null when no unit reports a consumption
 */
function monthsChart(units, now) {
  if (units.length === 0) {
    return null;
  }
  const year = now.getFullYear();
  const monthStart = (index) => new Date(year, index, 1).toISOString();
  const total = (half, index) =>
    round(
      units.reduce((sum, unit) => sum + (unit.energy.months?.[half]?.[index] ?? 0), 0),
      3,
    );
  const thisYear = [];
  const lastYear = [];
  for (let index = 0; index < 12; index += 1) {
    lastYear.push({ t: monthStart(index), v: total('lastYear', index) });
    if (index <= now.getMonth()) {
      thisYear.push({ t: monthStart(index), v: total('thisYear', index) });
    }
  }
  return {
    type: 'chart',
    chart_type: 'bar',
    title: { en: 'Energy per month', fr: 'Énergie par mois' },
    unit: 'kWh',
    series: [
      { name: String(year), points: thisYear },
      { name: String(year - 1), points: lastYear },
    ],
  };
}

/**
 * @param {string} externalId the feature the tile follows
 * @param {string} icon a Feather icon name
 * @param {string} en the English label
 * @param {string} fr the French label
 * @returns {object} a live value tile
 */
function tile(externalId, icon, en, fr) {
  return { type: 'value', device_feature: externalId, label: { en, fr }, icon };
}

/**
 * @param {{ en: string, fr: string }} text what to say
 * @param {number} ttl how long the core may keep it
 * @returns {object} a content made of one paragraph
 */
function message(text, ttl) {
  return { ttl_seconds: ttl, components: [{ type: 'text', variant: 'body', text }] };
}

/**
 * @param {number} remaining the calls left today
 * @returns {string} the color of the quota gauge
 */
function quotaColor(remaining) {
  if (remaining === 0) {
    return WIDGET_COLORS.DANGER;
  }
  return remaining <= QUOTA_LOW_THRESHOLD ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS;
}

/**
 * @param {number} celsius the temperature Daikin reports
 * @param {string} unitSystem `metric` or `us`
 * @param {string} language the language to format the number in
 * @returns {string} the temperature, in the user's unit
 */
function formatTemperature(celsius, unitSystem, language) {
  const imperial = unitSystem === 'us';
  const value = imperial ? (celsius * 9) / 5 + 32 : celsius;
  const text = new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
  return `${text} ${imperial ? '°F' : '°C'}`;
}

/**
 * @param {(language: string) => string} build the text in one language
 * @returns {Record<string, string>} the text in every language
 */
function perLanguage(build) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)]));
}

/**
 * @param {number} value the value to round
 * @param {number} digits the decimals to keep
 * @returns {number} the rounded value
 */
function round(value, digits) {
  return Number(value.toFixed(digits));
}

// -----------------------------------------------------------------------------
// The names this integration writes into Gladys, in English and in French.
//
// Why an integration has to translate them itself: Gladys renders a feature
// with the label of its own dictionary ONLY when the feature TYPE is unique
// inside the device (`getDeviceFeatureName`, front/src/utils/device.js) —
// otherwise it falls back to the raw `name` the integration published. A Daikin
// unit publishes three `energy-sensor/energy` features (today, this month, this
// year), two `temperature-sensor/decimal` ones and up to five `binary` ones, so
// exactly those fall back to the raw name. The energy monitoring screen goes
// further: it shows the stored name and nothing else, whatever the type. Hence
// the mixed reading a French user gets — "Consommation 30 minutes" next to
// "Energy today", both on the same device.
//
// The language cannot be read: the integration host API exposes the Gladys
// version, the service status and nothing about the user (`GET /status`). It is
// therefore a configuration field, with an `auto` default that reads the `TZ`
// the supervisor injects into the container (the Gladys system timezone) and
// only commits to French where that timezone leaves no doubt — a multilingual
// country stays on English rather than guessing wrong.
//
// The names are the ones the French documentation already uses, so the manual
// and the dashboard say the same words.
// -----------------------------------------------------------------------------

// The languages this integration publishes names in. `en` is the fallback of
// every lookup, and the manifest offers `auto` on top of these two.
export const LANGUAGES = ['en', 'fr'];
export const AUTO_LANGUAGE = 'auto';
export const DEFAULT_LANGUAGE = 'en';

// Timezones where French is the language of the household, with no realistic
// second reading: metropolitan France, Monaco and the French overseas
// territories. Belgium, Switzerland and Luxembourg are deliberately absent —
// their timezone says nothing about which of their languages is spoken, and a
// wrong guess is worse than the English default the user can override.
export const FRENCH_TIMEZONES = new Set([
  'Europe/Paris',
  'Europe/Monaco',
  'Indian/Reunion',
  'Indian/Mayotte',
  'America/Martinique',
  'America/Guadeloupe',
  'America/Cayenne',
  'America/Miquelon',
  'Pacific/Noumea',
  'Pacific/Tahiti',
  'Pacific/Marquesas',
  'Pacific/Gambier',
]);

// One entry per feature key of `src/devices/climateUnit.js` (a test enforces
// that the two lists stay in step).
const FEATURE_NAMES = {
  power: { en: 'On/Off', fr: 'Marche/Arrêt' },
  mode: { en: 'Mode', fr: 'Mode' },
  'target-temperature': { en: 'Target temperature', fr: 'Température de consigne' },
  'room-temperature': { en: 'Room temperature', fr: 'Température intérieure' },
  'outdoor-temperature': { en: 'Outdoor temperature', fr: 'Température extérieure' },
  'fan-level': { en: 'Fan speed', fr: 'Vitesse de ventilation' },
  'fan-rock': { en: 'Oscillation', fr: 'Oscillation' },
  'swing-horizontal': { en: 'Horizontal airflow', fr: 'Balayage horizontal' },
  'swing-vertical': { en: 'Vertical airflow', fr: 'Balayage vertical' },
  'energy-today': { en: 'Energy today', fr: "Énergie aujourd'hui" },
  'energy-month': { en: 'Energy this month', fr: 'Énergie ce mois-ci' },
  'energy-year': { en: 'Energy this year', fr: 'Énergie cette année' },
  'energy-today-consumption': {
    en: 'Energy today (consumption)',
    fr: "Énergie aujourd'hui (consommation)",
  },
  'energy-today-cost': { en: 'Energy today (cost)', fr: "Énergie aujourd'hui (coût)" },
  powerful: { en: 'Powerful mode', fr: 'Mode puissant' },
  econo: { en: 'Econo mode', fr: 'Mode Econo' },
  streamer: { en: 'Streamer mode', fr: 'Mode Streamer' },
  'dry-keep': { en: 'Keep dry', fr: 'Garder au sec' },
};

/**
 * The name to publish for a feature.
 * @param {string} featureKey one of the FEATURE keys of climateUnit.js
 * @param {string} [language] the language to publish in
 * @returns {string} the feature name, in English when the language is unknown
 */
export function featureName(featureKey, language = DEFAULT_LANGUAGE) {
  const names = FEATURE_NAMES[featureKey];
  if (!names) {
    throw new Error(`No published name for the feature "${featureKey}"`);
  }
  return names[language] ?? names[DEFAULT_LANGUAGE];
}

/**
 * The feature keys this module can name — the list a test compares to FEATURE.
 * @returns {Array<string>} the known feature keys
 */
export function namedFeatureKeys() {
  return Object.keys(FEATURE_NAMES);
}

/**
 * The language to publish in: the one the user picked, or the one the Gladys
 * timezone points at when the setting is left on `auto`.
 * @param {string} choice the `device_language` configuration value
 * @param {string} [timezone] the container timezone (TZ, injected by Gladys)
 * @returns {string} 'en' or 'fr'
 */
export function resolveLanguage(choice, timezone = process.env.TZ) {
  if (LANGUAGES.includes(choice)) {
    return choice;
  }
  return FRENCH_TIMEZONES.has(String(timezone ?? '')) ? 'fr' : DEFAULT_LANGUAGE;
}

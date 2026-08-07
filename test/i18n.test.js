// -----------------------------------------------------------------------------
// The names published to Gladys, and how the language is picked. What matters
// here is that no feature can reach Gladys unnamed, and that the automatic mode
// never guesses French out of a timezone that could mean something else.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  featureName,
  namedFeatureKeys,
  resolveLanguage,
} from '../src/i18n.js';
import { FEATURE } from '../src/devices/index.js';

test('every published feature has a name in every language', () => {
  const featureKeys = Object.values(FEATURE);
  for (const key of featureKeys) {
    for (const language of LANGUAGES) {
      const name = featureName(key, language);
      assert.equal(typeof name, 'string', `${key} in ${language}`);
      assert.ok(name.length > 0, `${key} in ${language}: must not be empty`);
    }
  }
  // The other way round too: a name nobody publishes is a leftover.
  assert.deepEqual(namedFeatureKeys().sort(), [...featureKeys].sort());
});

test('the French names differ from the English ones, except where they cannot', () => {
  // "Mode" and "Oscillation" are the same word in both languages; everything
  // else that stayed identical would be a translation someone forgot.
  const untranslated = Object.values(FEATURE).filter(
    (key) => featureName(key, 'fr') === featureName(key, 'en'),
  );
  assert.deepEqual(untranslated.sort(), [FEATURE.FAN_ROCK, FEATURE.MODE].sort());
});

test('an unknown language falls back to English rather than to nothing', () => {
  assert.equal(featureName(FEATURE.ENERGY_TODAY, 'de'), 'Energy today');
  assert.equal(featureName(FEATURE.ENERGY_TODAY), 'Energy today');
});

test('a feature with no published name is a programming error, not a blank name', () => {
  // Gladys would store `undefined` and the dashboard would read "(undefined)".
  assert.throws(() => featureName('not-a-feature'), /no published name/i);
});

test('the language picked by the user wins over the timezone', () => {
  assert.equal(resolveLanguage('en', 'Europe/Paris'), 'en');
  assert.equal(resolveLanguage('fr', 'America/New_York'), 'fr');
});

test('auto only commits to French where the timezone leaves no doubt', () => {
  assert.equal(resolveLanguage('auto', 'Europe/Paris'), 'fr');
  assert.equal(resolveLanguage('auto', 'Indian/Reunion'), 'fr');
  assert.equal(resolveLanguage('auto', 'Pacific/Noumea'), 'fr');
  // Multilingual countries: their timezone says nothing about the language
  // spoken in the house, so the default stands and the user can override it.
  assert.equal(resolveLanguage('auto', 'Europe/Brussels'), DEFAULT_LANGUAGE);
  assert.equal(resolveLanguage('auto', 'Europe/Zurich'), DEFAULT_LANGUAGE);
  assert.equal(resolveLanguage('auto', 'Europe/Luxembourg'), DEFAULT_LANGUAGE);
  // The supervisor falls back to UTC when Gladys has no timezone set.
  assert.equal(resolveLanguage('auto', 'UTC'), DEFAULT_LANGUAGE);
  assert.equal(resolveLanguage('auto', ''), DEFAULT_LANGUAGE);
  assert.equal(resolveLanguage(undefined, 'Europe/Paris'), 'fr');
});

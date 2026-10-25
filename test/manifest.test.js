// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer and by Gladys at install time,
// but neither can know which handlers this integration actually registers, nor
// which defaults the code assumes — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, MAX_POLL_FREQUENCY, MIN_POLL_FREQUENCY } from '../src/config.js';
import { SCENE_ACTION, SET_CLIMATE_MODES } from '../src/sceneActions.js';
import { SCENE_TRIGGER } from '../src/sceneEvents.js';
import { UNIT_CHART, WIDGET } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// The languages of the Gladys interface: every user-facing text carries all four.
const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Every action key registered through `gladys.onAction()` in index.js.
const REGISTERED_ACTIONS = ['test_connection'];

test('the manifest declares a device integration with the required fields', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  // Bounds enforced by the core manifest validator: a manifest outside them
  // is refused at install time, with no way to fix it from the UI.
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.deepEqual(Object.keys(manifest.description), LANGUAGES);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language}: must be 10-100 characters`,
    );
  }
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(
    manifest.docker_image,
    /:\d+\.\d+\.\d+$/,
    'an implicit :latest makes updates undetectable',
  );
  assert.ok(manifest.gladys_version);
});

test('the manifest version follows package.json', () => {
  assert.equal(manifest.version, packageJson.version);
  assert.ok(manifest.docker_image.endsWith(`:${packageJson.version}`));
});

test('the cover image is pinned to the released tag, never to a branch', () => {
  // A URL that never changes is a URL nobody re-fetches: pinned to `main`, a
  // redrawn cover stayed invisible in the store and on the docs site behind
  // whatever the caches had kept. Pinning it to the tag makes every release
  // publish an address no cache has seen.
  assert.match(
    manifest.cover_image,
    new RegExp(`/v${packageJson.version.replace(/\./g, '\\.')}/cover\\.png$`),
    'cover_image must point at the tag of this very version',
  );
});

test('the catalog categories are declared, and they require Gladys >= 4.86.0', () => {
  // The shelves the integration sits on in the store catalog: an integration
  // declaring none is only reachable through "All" and search. The store
  // vocabulary itself is checked by the store validator (an unknown key is
  // dropped there with a warning) — what this test pins is the coupling rule,
  // because a Gladys older than 4.86 validates manifests against a strict
  // field allowlist and rejects ANY unknown top-level field. Claiming a lower
  // minimum while declaring `categories` is refused by the store indexer.
  assert.ok(Array.isArray(manifest.categories));
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(
    new Set(manifest.categories).size,
    manifest.categories.length,
    'the categories must be unique',
  );
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

// The store's catalog vocabulary (Gladys 5.3 added transport, vehicles,
// servers and leisure). An unknown key is only dropped by the indexer, with a
// warning nobody reads: the integration would silently lose its shelf.
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
];

/**
 * The minimum Gladys version of the manifest range, as numbers.
 * @returns {Array<number>} [major, minor, patch]
 */
function gladysFloor() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

/**
 * Whether the manifest floor is at least the given version.
 * @param {number} major the major version
 * @param {number} minor the minor version
 * @returns {boolean} true when the floor covers it
 */
function floorAtLeast(major, minor) {
  const [floorMajor, floorMinor] = gladysFloor();
  return floorMajor > major || (floorMajor === major && floorMinor >= minor);
}

test('the catalog categories come from the store vocabulary', () => {
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category "${category}"`);
  }
});

test('the search keywords follow the store rules, and they require Gladys >= 5.3.0', () => {
  // Search-only terms (models, synonyms) the name and description do not carry.
  assert.ok(Array.isArray(manifest.keywords));
  assert.ok(manifest.keywords.length >= 1 && manifest.keywords.length <= 10);
  const normalized = manifest.keywords.map((keyword) => keyword.trim().toLowerCase());
  assert.equal(new Set(normalized).size, normalized.length, 'the keywords must be unique');
  for (const keyword of manifest.keywords) {
    assert.equal(typeof keyword, 'string');
    assert.ok(
      keyword.trim().length >= 2 && keyword.trim().length <= 30,
      `keyword "${keyword}" must be 2-30 characters`,
    );
  }
  // A core older than 5.3 rejects the unknown top-level field.
  assert.ok(
    floorAtLeast(5, 3),
    `keywords requires gladys_version >= 5.3.0, got "${manifest.gladys_version}"`,
  );
});

test('the integration is not restricted to some countries', () => {
  // Onecta serves Daikin units wherever they are sold: no `countries`, which
  // would hide the integration from every other country's catalog.
  assert.equal(manifest.countries, undefined);
});

test('the integration requires Gladys >= 5.3.0', () => {
  // Pinned on its own too: `keywords` (and `countries`, `music`) need 5.3.0.
  assert.deepEqual(gladysFloor(), [5, 3, 0]);
});

test('the widgets and the scene declarations require Gladys >= 5.1.0', () => {
  // Same coupling as `categories`, one release later: a Gladys older than
  // 5.1 rejects the unknown top-level fields, and the store indexer refuses a
  // manifest whose range claims otherwise.
  assert.ok(
    floorAtLeast(5, 1),
    `widgets, scene_triggers and scene_actions require gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every declared widget, scene trigger and scene action is served by the code', () => {
  // index.js registers its handlers from these constants, and the scenes and
  // dashboards store these keys: the two lists must be the same, both ways.
  const keys = (list) => (list ?? []).map((entry) => entry.key).sort();
  assert.deepEqual(keys(manifest.widgets), Object.values(WIDGET).sort());
  assert.deepEqual(keys(manifest.scene_actions), Object.values(SCENE_ACTION).sort());
  assert.deepEqual(keys(manifest.scene_triggers), Object.values(SCENE_TRIGGER).sort());
});

test('the select options of the capabilities are the values the code reads', () => {
  const optionsOf = (field) => field.options.map((option) => option.value);
  const unitWidget = manifest.widgets.find((widget) => widget.key === WIDGET.UNIT);
  const chart = unitWidget.settings.find((field) => field.key === 'chart');
  assert.deepEqual(optionsOf(chart).sort(), Object.values(UNIT_CHART).sort());
  assert.ok(Object.values(UNIT_CHART).includes(chart.default));

  const setClimate = manifest.scene_actions.find(
    (action) => action.key === SCENE_ACTION.SET_CLIMATE,
  );
  const field = (key) => setClimate.fields.find((entry) => entry.key === key);
  assert.deepEqual(optionsOf(field('mode')), ['unchanged', ...SET_CLIMATE_MODES]);
  assert.deepEqual(optionsOf(field('power')), ['on', 'off', 'unchanged']);

  const trigger = (key) => manifest.scene_triggers.find((entry) => entry.key === key);
  const filter = (key, name) => trigger(key).fields.find((entry) => entry.key === name);
  assert.deepEqual(optionsOf(filter(SCENE_TRIGGER.UNIT_CONNECTION, 'connection')).sort(), [
    'offline',
    'online',
  ]);
  assert.deepEqual(optionsOf(filter(SCENE_TRIGGER.UNIT_ERROR, 'state')).sort(), ['error', 'ok']);
});

test('the unit pickers list the devices of this integration', () => {
  // A `source: "devices"` select hands the handler the device external_id,
  // which is what `findUnitByDevice` routes on.
  const pickers = [
    ...manifest.widgets.flatMap((widget) => widget.settings ?? []),
    ...manifest.scene_triggers.flatMap((trigger) => trigger.fields ?? []),
    ...manifest.scene_actions.flatMap((action) => action.fields ?? []),
  ].filter((field) => field.key === 'unit');
  assert.ok(pickers.length > 0);
  for (const picker of pickers) {
    assert.equal(picker.type, 'select');
    assert.equal(picker.source, 'devices');
  }
});

test('the integration declares itself as cloud only', () => {
  // Daikin exposes no documented local API for these units: there is no local
  // channel to prefer, and declaring one would show a misleading toggle.
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      REGISTERED_ACTIONS.includes(action.key),
      `manifest action "${action.key}" has no handler`,
    );
  }
  assert.equal(
    manifest.actions.length,
    REGISTERED_ACTIONS.length,
    'a registered action must be declared too',
  );
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('the refresh interval bounds match what the code enforces', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'poll_frequency');
  assert.equal(field.min, MIN_POLL_FREQUENCY);
  assert.equal(field.max, MAX_POLL_FREQUENCY);
});

test('the OAuth2 flow is declared, and the credentials it needs come first', () => {
  const keys = manifest.config_schema.map((field) => field.key);
  const oauthField = manifest.config_schema.find((field) => field.type === 'oauth2');
  assert.ok(oauthField, 'the Connect button comes from an oauth2 field');
  assert.ok(
    keys.indexOf('client_id') < keys.indexOf(oauthField.key) &&
      keys.indexOf('client_secret') < keys.indexOf(oauthField.key),
    'the user must fill in the application credentials before connecting',
  );
});

test('the client secret is stored as a secret, never as a plain string', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'client_secret');
  assert.equal(field.type, 'secret');
});

test('the OAuth2 tokens are never declared in the schema', () => {
  const keys = manifest.config_schema.map((field) => field.key);
  for (const reserved of ['access_token', 'refresh_token', 'token_expires_at']) {
    assert.ok(!keys.includes(reserved), `${reserved} is internal storage, it must stay off-schema`);
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0, 'the onboarding guidance lives in section blocks');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(!(section.key in DEFAULT_CONFIG), `section "${section.key}" stores no value`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('every user-facing text is translated in English, French, German and Spanish', () => {
  const texts = [manifest.description];
  for (const field of manifest.config_schema) {
    texts.push(field.label);
    if (field.description) {
      texts.push(field.description);
    }
    for (const link of field.links ?? []) {
      texts.push(link.label);
    }
  }
  for (const action of manifest.actions ?? []) {
    texts.push(action.label);
    if (action.description) {
      texts.push(action.description);
    }
  }
  const capabilities = [
    ...(manifest.widgets ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ];
  for (const capability of capabilities) {
    texts.push(capability.label);
    if (capability.description) {
      texts.push(capability.description);
    }
    const fields = [...(capability.settings ?? []), ...(capability.fields ?? [])];
    for (const field of fields) {
      texts.push(field.label);
      if (field.description) {
        texts.push(field.description);
      }
      for (const option of field.options ?? []) {
        texts.push(option.label);
      }
    }
    for (const value of [...(capability.variables ?? []), ...(capability.outputs ?? [])]) {
      texts.push(value.label);
    }
  }
  for (const text of texts) {
    for (const language of LANGUAGES) {
      assert.ok(text[language], `missing "${language}" text in ${JSON.stringify(text)}`);
    }
  }
});

test('the widget texts fit the store bounds in every language', () => {
  for (const widget of manifest.widgets ?? []) {
    for (const language of LANGUAGES) {
      const label = widget.label[language];
      assert.ok(label.length >= 3 && label.length <= 30, `${widget.key}.label.${language}: 3-30`);
      assert.ok(
        widget.description[language].length <= 100,
        `${widget.key}.description.${language}: at most 100 characters`,
      );
    }
  }
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    for (const language of LANGUAGES) {
      assert.ok(
        (section.description?.[language] ?? '').length <= 1000,
        `${section.key}.description.${language}: at most 1000 characters`,
      );
    }
  }
});

test('config keys use the format the core accepts', () => {
  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/);
  }
});

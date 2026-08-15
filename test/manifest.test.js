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

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every action key registered through `gladys.onAction()` in index.js.
const REGISTERED_ACTIONS = ['test_connection'];

test('the manifest declares a device integration with the required fields', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  // Bounds enforced by the core manifest validator: a manifest outside them
  // is refused at install time, with no way to fix it from the UI.
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
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

test('every user-facing text is translated in English and French', () => {
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
  for (const text of texts) {
    assert.ok(text.en, `missing English text in ${JSON.stringify(text)}`);
    assert.ok(text.fr, `missing French text in ${JSON.stringify(text)}`);
  }
});

test('config keys use the format the core accepts', () => {
  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/);
  }
});

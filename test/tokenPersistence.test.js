import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenPersistence } from '../src/tokenPersistence.js';

const SESSION = { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 };
const ROTATED = { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 };

/**
 * A Gladys config whose writes fail while `down` is true.
 * @returns {{ saved: Array<object>, attempts: { count: number }, link: { down: boolean }, save: Function }} the fake
 */
function fakeConfig() {
  const saved = [];
  const attempts = { count: 0 };
  const link = { down: false };
  return {
    saved,
    attempts,
    link,
    async save(partial) {
      attempts.count += 1;
      if (link.down) {
        throw new Error('Gladys is not connected');
      }
      saved.push(partial);
    },
  };
}

test('a renewed session is saved at once', async () => {
  const config = fakeConfig();
  const persistence = new TokenPersistence(config);
  assert.equal(await persistence.persist(SESSION), true);
  assert.equal(config.saved.length, 1);
  assert.equal(Object.values(config.saved[0]).includes('r1'), true);
  assert.equal(persistence.hasPending, false);
});

test('a save that failed is retried at the next operation, not forgotten', async () => {
  const config = fakeConfig();
  const persistence = new TokenPersistence(config);
  config.link.down = true;
  // Never throws: the renewal itself worked, the read that caused it goes on.
  assert.equal(await persistence.persist(SESSION), false);
  assert.equal(persistence.hasPending, true);

  // Still down: kept again.
  assert.equal(await persistence.flush(), false);
  assert.equal(persistence.hasPending, true);

  config.link.down = false;
  assert.equal(await persistence.flush(), true);
  assert.equal(persistence.hasPending, false);
  assert.equal(config.saved.length, 1);
  assert.equal(Object.values(config.saved[0]).includes('r1'), true);

  // Nothing pending: flushing costs nothing.
  const before = config.attempts.count;
  await persistence.flush();
  assert.equal(config.attempts.count, before);
});

test('only the latest session is kept when another renewal happens first', async () => {
  const config = fakeConfig();
  const persistence = new TokenPersistence(config);
  config.link.down = true;
  await persistence.persist(SESSION);
  await persistence.persist(ROTATED);
  config.link.down = false;
  await persistence.flush();
  assert.equal(config.saved.length, 1);
  assert.equal(Object.values(config.saved[0]).includes('r2'), true, 'the rotated token wins');
});

test('concurrent flushes save one session once', async () => {
  const config = fakeConfig();
  const persistence = new TokenPersistence(config);
  config.link.down = true;
  await persistence.persist(SESSION);
  config.link.down = false;
  await Promise.all([persistence.flush(), persistence.flush(), persistence.flush()]);
  assert.equal(config.saved.length, 1);
});

test('a session replaced by a new link is dropped', async () => {
  const config = fakeConfig();
  const persistence = new TokenPersistence(config);
  config.link.down = true;
  await persistence.persist(SESSION);
  persistence.discard();
  config.link.down = false;
  await persistence.flush();
  assert.equal(config.saved.length, 0);
});

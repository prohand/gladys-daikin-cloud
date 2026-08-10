// -----------------------------------------------------------------------------
// The UUID a feature is created with, derived from its external_id.
//
// Gladys links the energy monitoring features together by `energy_parent_id`,
// which holds the UUID of the PARENT FEATURE ROW — not its external_id. An
// integration publishing a "30 minutes consumption" therefore has to know the
// id of the index it hangs on before Gladys has created either of them, which
// only works if the integration chooses those ids itself (`device.create`
// inserts the features first, then resolves the parent links against the rows
// it just wrote).
//
// Choosing them at random would work exactly once: the next publish would carry
// different ids, and Gladys — matching a feature it already stores by
// external_id — would rewrite its primary key, orphaning every state hanging on
// it. So the id is a UUID v5 (RFC 4122 §4.3): the same external_id always
// derives the same id, across restarts, redeploys and reinstalls.
//
// This is only a default. A feature Gladys already knows keeps the id Gladys
// gave it — see `buildDevice()`.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

// Namespace of this integration, generated once and frozen: it is what keeps
// these ids from colliding with the ids another integration would derive from
// a similar string.
const NAMESPACE = '0a76c59f-4c86-40ea-8fbc-4d4976764ec8';

/**
 * The deterministic UUID v5 of a feature.
 * @param {string} externalId the feature external_id
 * @returns {string} the UUID to create that feature with
 */
export function featureUuid(externalId) {
  const hash = createHash('sha1');
  hash.update(Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex'));
  hash.update(Buffer.from(externalId, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);
  // Version 5 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

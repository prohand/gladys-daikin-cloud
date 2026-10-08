// -----------------------------------------------------------------------------
// The Daikin writes of one command, and what they leave in the snapshot.
//
// A command is often several PATCHes (a fan level is `currentMode = fixed`
// then the level; a mode change may switch the unit on first), and Daikin
// applies each one the moment it accepts it — there is no transaction. When a
// later write fails, the earlier ones are ALREADY in effect on the unit, so
// the snapshot has to say so: otherwise the widgets, a republish and the next
// step of `set_climate` describe the unit as it was before, until the next
// scheduled read up to 15 minutes later.
//
// Kept apart from index.js (which instantiates the SDK on import) so this
// ordering can be tested.
// -----------------------------------------------------------------------------

/**
 * Send the writes of one command, in order, and reflect the accepted ones in
 * the store's snapshot — all of them on success, the ones Daikin accepted
 * before the failure otherwise. The error of the failed write is rethrown.
 * @param {{ api: object, store: object, unit: object, writes: Array<object> }} params the
 * Daikin client, the store holding the snapshot, the unit the command targets and its writes
 * @returns {Promise<void>} resolves once every write was accepted
 */
export async function sendWrites({ api, store, unit, writes }) {
  // Before the first write, not after the last: a scheduled read starting in
  // between must wait for the quiet period too.
  store.markCommandSent();
  const accepted = [];
  try {
    for (const write of writes) {
      await api.setCharacteristic({
        deviceId: unit.deviceId,
        // Most characteristics belong to the climate control point, but a few
        // (the indoor unit's "keep dry") live on another one and carry it.
        embeddedId: write.embeddedId ?? unit.embeddedId,
        characteristic: write.characteristic,
        path: write.path,
        value: write.value,
      });
      accepted.push(write);
    }
  } finally {
    // The Daikin cloud serves the previous values for a few seconds after a
    // write, accepted or not: the quiet period restarts from the last one.
    store.markCommandSent();
    if (accepted.length > 0) {
      // A read already queued when the command was sent replaces the snapshot
      // with the values from BEFORE it (the API serializes requests, so it
      // answers first). Patching the object captured by the caller would then
      // change a unit no longer in the snapshot: patch the unit it holds now.
      store.applyWrites(store.getUnit(unit.platformId) ?? unit, accepted);
    }
  }
}

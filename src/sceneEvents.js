// -----------------------------------------------------------------------------
// Scene triggers: what HAPPENED to the Daikin account between two reads.
//
// Gladys 5.1 lets an integration declare its own scene triggers. A trigger is
// an event, never a state: a temperature, a mode or the power are device
// features, and the scene editor already reacts to those. What the features
// cannot express is a CHANGE of something that is not a feature — a unit whose
// Wi-Fi adapter dropped off the cloud, a unit that starts reporting a fault,
// the daily quota running out, the Daikin session dying — which today only
// shows up as a badge or a status line nobody is looking at when it matters.
//
// The cloud is polled (see src/store.js), so every event here is a TRANSITION
// between two snapshots, fired once:
//   - the first read after a start only sets the baseline — a restart must
//     never announce that every unit "came back online";
//   - a unit that appears in the account starts silently, the same way;
//   - the fault flag of an unreachable unit is the last one Daikin kept, so
//     it is only compared while the unit is reachable on both reads.
//
// No scene can loop through these. A write cannot take a unit off the cloud,
// raise a fault or kill the session; it does spend quota, but the quota event
// fires once on the way down and re-arms only when the daily counter climbs
// back over the threshold — a scene answering it with a command cannot fire it
// again.
//
// Pure: the tracker returns the events, index.js publishes them.
// -----------------------------------------------------------------------------

// The keys the scenes store. Published once, they are never renamed: a renamed
// key is a removed key for every scene using it.
export const SCENE_TRIGGER = {
  UNIT_CONNECTION: 'unit_connection_changed',
  UNIT_ERROR: 'unit_error_changed',
  QUOTA_LOW: 'api_quota_low',
  SESSION_EXPIRED: 'daikin_session_expired',
};

// Under this many calls left today, a scene still has room to warn someone
// before the integration goes blind: at the default interval, 20 calls is
// five hours of refreshes with nothing else spent.
export const QUOTA_LOW_THRESHOLD = 20;

export class SceneEventTracker {
  constructor() {
    /** @type {Map<string, { online: boolean, inErrorState: boolean }>|null} null until the first read */
    this.units = null;
    /** @type {boolean|null} null until the quota has been read once */
    this.quotaLow = null;
    this.sessionExpired = false;
  }

  /**
   * Compare a fresh read with the previous one.
   * @param {Array<object>} units the units just read
   * @param {Function} describe `(unit) => { unit, unit_name }`: how a unit is named in an event
   * @returns {Array<{ key: string, data: object }>} the events to publish
   */
  unitsRead(units, describe) {
    // A successful read means the session works again: the next expiry is a
    // new event.
    this.sessionExpired = false;
    const previous = this.units;
    this.units = new Map(
      units.map((unit) => [
        unit.platformId,
        { online: unit.online, inErrorState: unit.inErrorState },
      ]),
    );
    if (!previous) {
      return [];
    }

    const events = [];
    for (const unit of units) {
      const before = previous.get(unit.platformId);
      if (!before) {
        continue;
      }
      if (before.online !== unit.online) {
        events.push({
          key: SCENE_TRIGGER.UNIT_CONNECTION,
          data: { ...describe(unit), connection: unit.online ? 'online' : 'offline' },
        });
      }
      if (before.online && unit.online && before.inErrorState !== unit.inErrorState) {
        events.push({
          key: SCENE_TRIGGER.UNIT_ERROR,
          data: { ...describe(unit), state: unit.inErrorState ? 'error' : 'ok' },
        });
      }
    }
    return events;
  }

  /**
   * Follow the daily quota Daikin reports after every call.
   * @param {{ remainingDay: number|null, limitDay: number|null }} rateLimits the last rate limit headers
   * @returns {Array<{ key: string, data: object }>} the events to publish
   */
  quotaRead({ remainingDay, limitDay }) {
    if (typeof remainingDay !== 'number') {
      return [];
    }
    const low = remainingDay <= QUOTA_LOW_THRESHOLD;
    const wasLow = this.quotaLow;
    this.quotaLow = low;
    // Fired on the way down only, and not on the first reading: a restart
    // late in a busy day would otherwise warn again about the same quota.
    if (wasLow === false && low) {
      return [{ key: SCENE_TRIGGER.QUOTA_LOW, data: { remaining: remainingDay, limit: limitDay } }];
    }
    return [];
  }

  /**
   * Turn a failed read into the event it means, if any. A 429 needs nothing
   * here: Daikin sends its rate limit headers on the refusal too, and it also
   * answers 429 to the per-MINUTE limit — only the daily counter those headers
   * carry tells the two apart, and `quotaRead` already follows it.
   * @param {Error & { isAuthError?: boolean }} err what went wrong
   * @returns {Array<{ key: string, data: object }>} the events to publish
   */
  refreshFailed(err) {
    if (!err?.isAuthError || this.sessionExpired) {
      return [];
    }
    this.sessionExpired = true;
    return [{ key: SCENE_TRIGGER.SESSION_EXPIRED, data: {} }];
  }
}

// -----------------------------------------------------------------------------
// The state of the Daikin account, and the schedule that keeps it fresh.
//
// Why a store instead of the poll_frequency of the discovered devices: Gladys
// polls a device every minute at the slowest, and `GET /v1/gateway-devices`
// already returns EVERY unit of the account in one call. With a quota of 200
// requests per day, a per-device poll would be spent before noon. So the
// integration schedules its own refresh (every 15 minutes by default), reads
// the whole account once, and serves every unit from that snapshot.
//
// Two more rules the Daikin cloud imposes:
//   - concurrent refreshes are collapsed into the one already in flight;
//   - a read right after a write returns the PREVIOUS values, so the store
//     waits out a short quiet period after each command.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { parseUnits } from './daikin/model.js';

const logger = createLogger({ name: 'store' });

// The Daikin cloud needs a moment before a write is visible to a read.
export const POST_COMMAND_QUIET_MS = 10_000;

export class DaikinStore {
  /**
   * @param {{ api: object }} params the Daikin API client to read through
   */
  constructor({ api }) {
    this.api = api;
    /** @type {Array<object>} the units of the account, as of the last refresh */
    this.units = [];
    this.lastRefreshAt = 0;
    this.lastCommandAt = 0;
    this.inFlight = null;
    this.timer = null;
  }

  /**
   * Read the whole account and update the snapshot. Callers that arrive while
   * a refresh is running wait for it instead of spending another request.
   * @returns {Promise<Array<object>>} the refreshed units
   */
  async refresh() {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * The actual read, quiet period included.
   * @returns {Promise<Array<object>>} the refreshed units
   */
  async doRefresh() {
    const quietFor = this.lastCommandAt + POST_COMMAND_QUIET_MS - Date.now();
    if (quietFor > 0) {
      logger.debug(`Waiting ${quietFor} ms after the last command before reading the Daikin cloud`);
      await sleep(quietFor);
    }
    const gatewayDevices = await this.api.getGatewayDevices();
    this.units = parseUnits(gatewayDevices);
    this.lastRefreshAt = Date.now();
    logger.info(`Read ${this.units.length} climate unit(s) from the Daikin cloud`);
    return this.units;
  }

  /**
   * Mark the moment a command was sent, opening the quiet period.
   */
  markCommandSent() {
    this.lastCommandAt = Date.now();
  }

  /**
   * Apply what a command just changed to the local snapshot, so a feature read
   * before the next refresh (a scene, the dashboard) sees the new value.
   * @param {object} unit the unit that received the command
   * @param {Array<object>} writes the writes that were accepted
   */
  applyWrites(unit, writes) {
    for (const write of writes) {
      if (write.characteristic === 'onOffMode') {
        unit.power = write.value;
      } else if (write.characteristic === 'operationMode') {
        unit.operationMode = write.value;
        unit.setpoint = unit.setpoints[write.value] ?? null;
      } else if (write.characteristic === 'temperatureControl' && unit.setpoint) {
        unit.setpoint = { ...unit.setpoint, value: write.value };
        unit.setpoints[unit.operationMode] = unit.setpoint;
      } else if (write.characteristic === 'fanControl') {
        applyFanWrite(unit, write);
      }
    }
  }

  /**
   * Find a unit in the current snapshot.
   * @param {string} platformId the `${deviceId}_${embeddedId}` identifier
   * @returns {object|undefined} the unit, when it still exists
   */
  getUnit(platformId) {
    return this.units.find((unit) => unit.platformId === platformId);
  }

  /**
   * Start (or restart) the periodic refresh.
   * @param {number} frequencySeconds the interval between two reads
   * @param {Function} onRefresh called with the refreshed units after each run
   */
  startPolling(frequencySeconds, onRefresh) {
    this.stopPolling();
    logger.info(`Polling the Daikin cloud every ${frequencySeconds} s`);
    this.timer = setInterval(() => {
      this.refresh()
        .then((units) => onRefresh(units))
        .catch((err) => logger.error('Scheduled refresh failed', err));
    }, frequencySeconds * 1000);
    // Never hold the process alive just for the timer.
    this.timer.unref?.();
  }

  /** Stop the periodic refresh (disconnection, shutdown, config change). */
  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Reflect a fan control write in the local snapshot.
 * @param {object} unit the unit that received the command
 * @param {object} write the accepted write
 */
function applyFanWrite(unit, write) {
  if (!unit.fan) {
    return;
  }
  if (write.path?.endsWith('/fanSpeed/currentMode') && unit.fan.speed) {
    unit.fan.speed.currentMode = write.value;
  } else if (write.path?.endsWith('/fanSpeed/modes/fixed') && unit.fan.speed?.fixed) {
    unit.fan.speed.fixed.value = write.value;
  } else {
    const axisMatch = write.path?.match(/\/fanDirection\/(horizontal|vertical)\/currentMode$/);
    if (axisMatch && unit.fan.direction?.[axisMatch[1]]) {
      unit.fan.direction[axisMatch[1]].value = write.value;
    }
  }
}

/**
 * @param {number} ms how long to wait
 * @returns {Promise<void>} resolves after the delay
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

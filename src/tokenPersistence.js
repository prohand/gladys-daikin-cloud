// -----------------------------------------------------------------------------
// Saving the Daikin session the API client just renewed.
//
// Daikin ROTATES the refresh token: once a renewal succeeded, the refresh
// token stored in the Gladys config is dead. If saving the new one fails (the
// WebSocket to Gladys dropped, the core restarting), the integration still
// works from memory — until the container restarts, reads the dead token back
// and asks the user for another trip through the consent screen. A failed save
// is therefore kept and retried at the next operation instead of being logged
// and forgotten, and the session in memory is the one that counts until it
// reached Gladys.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { tokensToConfig } from './config.js';

const logger = createLogger({ name: 'tokens' });

export class TokenPersistence {
  /**
   * @param {{ save: (partialConfig: object) => Promise<unknown> }} params writes a partial
   * config to Gladys (`gladys.setConfig`)
   */
  constructor({ save }) {
    this.save = save;
    /** @type {object|null} the renewed session not saved yet, if any */
    this.pending = null;
    this.saving = null;
  }

  /** @returns {boolean} true while a renewed session still has to reach Gladys */
  get hasPending() {
    return this.pending !== null;
  }

  /**
   * Save a renewed session now; on failure, keep it for the next `flush()`.
   * Never throws: the renewal itself succeeded, the request that triggered it
   * must go on.
   * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens the session
   * @returns {Promise<boolean>} true once this session is saved
   */
  async persist(tokens) {
    this.pending = { ...tokens };
    return this.flush();
  }

  /**
   * Retry the save of a session that could not be saved earlier. A no-op
   * when nothing is pending, so it can be called after every operation.
   * Never throws.
   * @returns {Promise<boolean>} true when nothing is left to save
   */
  async flush() {
    // One save at a time: two in flight could land in the wrong order and
    // leave the older session in the config.
    while (this.saving) {
      await this.saving;
    }
    const tokens = this.pending;
    if (!tokens) {
      return true;
    }
    this.saving = this.save(tokensToConfig(tokens))
      .then(() => {
        // A renewal that happened meanwhile is still pending.
        if (this.pending === tokens) {
          this.pending = null;
        }
      })
      .catch((err) => {
        logger.error('Could not persist the refreshed Daikin tokens, will retry', err);
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
    return this.pending === null;
  }

  /**
   * Forget a pending session that another one replaced (the user linked the
   * account again: that new session is saved by its own path).
   */
  discard() {
    this.pending = null;
  }
}

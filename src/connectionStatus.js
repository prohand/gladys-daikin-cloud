// -----------------------------------------------------------------------------
// What the Configuration screen says about the link with the Daikin cloud.
//
// A cloud integration can be RUNNING and still unable to talk to its provider.
// The status used to be written by the paths a user starts (the connection,
// the test button, a scene) and by the scheduled publish, but a SCHEDULED READ
// that failed — a refresh token revoked from the Onecta app, the daily quota
// spent — was only logged: the screen kept saying "Connected" over an
// integration that had stopped updating. Every read goes through the store,
// so its failure hook reports here, and the next read that works puts the
// status back.
// -----------------------------------------------------------------------------

/**
 * The message for a failure, by what the user can do about it.
 * @param {Error & { isAuthError?: boolean, isRateLimited?: boolean }} err what went wrong
 * @returns {{ en: string, fr: string }} the message for the Configuration screen
 */
export function failureMessage(err) {
  if (err?.isAuthError) {
    return {
      en: 'The Daikin session expired, please reconnect your account.',
      fr: 'La session Daikin a expiré, reconnectez votre compte.',
    };
  }
  if (err?.isRateLimited) {
    return {
      en: 'Daikin API quota reached, increase the refresh interval.',
      fr: "Quota de l'API Daikin atteint, augmentez l'intervalle de rafraîchissement.",
    };
  }
  return {
    en: 'Could not reach the Daikin cloud, check the integration logs.',
    fr: "Impossible de joindre le cloud Daikin, consultez les logs de l'intégration.",
  };
}

export class ConnectionStatus {
  /**
   * @param {{ gladys: object, api: object }} params the SDK (for setConnectionStatus) and the
   * Daikin client (for the quota and whether an account is linked)
   */
  constructor({ gladys, api }) {
    this.gladys = gladys;
    this.api = api;
    /** Whether the screen currently shows a failure this reporter wrote. */
    this.failing = false;
  }

  /**
   * Report the integration as connected, and show what is left of the Daikin
   * daily quota under the Connect button. The Configuration screen renders the
   * status message whether the integration is up or down, which makes it the
   * one place a live counter can live without inventing a UI for it — and the
   * quota is the number that actually decides how this integration behaves.
   */
  async connected() {
    this.failing = false;
    const { remainingDay, limitDay } = this.api.rateLimits;
    if (remainingDay === null || remainingDay === undefined) {
      await this.gladys.setConnectionStatus(true).catch(() => {});
      return;
    }
    const total = limitDay === null || limitDay === undefined ? '' : `/${limitDay}`;
    await this.gladys
      .setConnectionStatus(true, {
        en: `Connected. ${remainingDay}${total} Daikin API calls left today.`,
        fr: `Connecté. ${remainingDay}${total} appels d'API Daikin restants aujourd'hui.`,
      })
      .catch(() => {});
  }

  /**
   * Surface a failure in the Configuration screen.
   * @param {Error & { isAuthError?: boolean, isRateLimited?: boolean }} err what went wrong
   */
  async failed(err) {
    this.failing = true;
    await this.gladys.setConnectionStatus(false, failureMessage(err)).catch(() => {});
  }

  /**
   * A read of the account failed, whoever asked for it (the schedule above
   * all, which has no one else to tell).
   * @param {Error} err the read failure
   */
  async readFailed(err) {
    // Without a linked account every read is a 401 too, and the screen already
    // says "no account linked": that message must stay.
    if (!this.api.isConnected) {
      return;
    }
    await this.failed(err);
  }

  /**
   * A read of the account worked: clear a failure shown earlier. When nothing
   * failed, the status is left to the paths that already write it — no need
   * for a status update per read.
   */
  async readSucceeded() {
    if (this.failing) {
      await this.connected();
    }
  }
}

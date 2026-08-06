'use strict';

/**
 * SpendGuard — pre-payment spend-limit check for MPP (Machine Payments Protocol) sessions.
 *
 * Mirrors the x402-spend-guard model: before an agent authorizes payment for an
 * MPP "Challenge" (the 402 response describing price/payment options), SpendGuard
 * decides ALLOW or BLOCK based on configured limits, and every decision is logged.
 *
 * This class is transport-agnostic — it does not talk to Tempo, Stripe, or any
 * network itself. It only makes the allow/block decision. Wire it up to a real
 * MPP client (e.g. mppx) in src/index.js.
 */

class SpendGuard {
  /**
   * @param {object} config
   * @param {number} config.perRequestCapMinor   Max amount (in minor units, e.g. cents/µUSD) allowed for a single request.
   * @param {number} config.sessionCapMinor      Max cumulative amount allowed for the whole session.
   * @param {number} [config.maxRequestsPerWindow]  Max number of requests allowed per rate-limit window.
   * @param {number} [config.windowMs=60000]     Rate-limit window size in ms.
   * @param {string[]} [config.allowedRecipients] If set, only these recipient addresses/IDs are allowed.
   */
  constructor(config) {
    if (!config || typeof config.perRequestCapMinor !== 'number' || typeof config.sessionCapMinor !== 'number') {
      throw new Error('SpendGuard requires perRequestCapMinor and sessionCapMinor');
    }
    this.config = {
      windowMs: 60_000,
      maxRequestsPerWindow: Infinity,
      allowedRecipients: null,
      ...config,
    };

    this._sessionSpentMinor = 0;
    this._requestTimestamps = [];
  }

  /**
   * Evaluate a proposed charge described by an MPP Challenge.
   * @param {object} challenge
   * @param {number} challenge.amountMinor  Price of the resource, in minor units.
   * @param {string} [challenge.recipient]  Recipient wallet/account the payment would go to.
   * @param {string} [challenge.resource]   Identifier of the resource being requested (for logging).
   * @returns {{allowed: boolean, reason: string, sessionSpentMinor: number}}
   */
  evaluate(challenge) {
    const now = Date.now();
    const { amountMinor, recipient, resource } = challenge;

    if (typeof amountMinor !== 'number' || amountMinor < 0) {
      return this._deny('invalid_amount', challenge);
    }

    if (amountMinor > this.config.perRequestCapMinor) {
      return this._deny('exceeds_per_request_cap', challenge);
    }

    if (this._sessionSpentMinor + amountMinor > this.config.sessionCapMinor) {
      return this._deny('exceeds_session_cap', challenge);
    }

    if (this.config.allowedRecipients && recipient && !this.config.allowedRecipients.includes(recipient)) {
      return this._deny('recipient_not_allowlisted', challenge);
    }

    // Rate limiting: drop timestamps outside the current window, then check count.
    this._requestTimestamps = this._requestTimestamps.filter((t) => now - t < this.config.windowMs);
    if (this._requestTimestamps.length >= this.config.maxRequestsPerWindow) {
      return this._deny('rate_limit_exceeded', challenge);
    }

    return {
      allowed: true,
      reason: 'ok',
      sessionSpentMinor: this._sessionSpentMinor,
      resource,
    };
  }

  /**
   * Call this AFTER a payment has actually been authorized/settled, so the guard's
   * session-spend tracking reflects reality. Keeping evaluate() and recordSpend()
   * separate avoids counting a charge that was evaluated but never actually sent.
   */
  recordSpend(amountMinor) {
    this._sessionSpentMinor += amountMinor;
    this._requestTimestamps.push(Date.now());
    return this._sessionSpentMinor;
  }

  _deny(reason, challenge) {
    return {
      allowed: false,
      reason,
      sessionSpentMinor: this._sessionSpentMinor,
      resource: challenge && challenge.resource,
    };
  }
}

module.exports = { SpendGuard };

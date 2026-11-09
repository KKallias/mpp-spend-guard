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
    // Payments whose outcome is unknown (credential may have been sent, but no
    // response came back). Keyed by payment id -> { amountMinor, resource }.
    this._pending = new Map();
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

    // Strict: only non-negative safe integers in minor units. Rejects NaN,
    // ±Infinity, fractions, numeric strings, null/undefined and bigint — any of
    // which would otherwise slip past `<`/`>` comparisons (NaN compares false).
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      return this._deny('invalid_amount', challenge);
    }

    // A payment to this resource is still awaiting reconciliation — retrying
    // could pay twice. Entries without a known resource block everything.
    for (const entry of this._pending.values()) {
      if (entry.resource === undefined || entry.resource === resource) {
        return this._deny('pending_reconciliation', challenge);
      }
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
    assertValidAmount(amountMinor, 'recordSpend');
    this._sessionSpentMinor += amountMinor;
    this._requestTimestamps.push(Date.now());
    return this._sessionSpentMinor;
  }

  /**
   * Call when a payment's outcome is unknown (e.g. timed out after the
   * credential was signed). The amount is counted as spent — fail closed — and
   * further payments to the same resource are blocked until reconcile().
   * @param {string} id            Payment id (from guardedPay).
   * @param {number} amountMinor   Amount that may have been paid.
   * @param {string} [resource]    Resource it was paid for. If omitted, ALL
   *                               resources are blocked until reconciled.
   */
  markOutcomeUnknown(id, amountMinor, resource) {
    assertValidAmount(amountMinor, 'markOutcomeUnknown');
    if (this._pending.has(id)) throw new Error(`markOutcomeUnknown: id ${id} is already pending`);
    this._sessionSpentMinor += amountMinor;
    this._requestTimestamps.push(Date.now());
    this._pending.set(id, { amountMinor, resource });
    return this._sessionSpentMinor;
  }

  /**
   * Resolve a pending payment after checking the real (on-chain) outcome.
   * @param {string} id
   * @param {{settled: boolean}} outcome  settled=false releases the amount.
   * @returns {boolean} false if no pending entry had that id.
   */
  reconcile(id, { settled } = {}) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    if (settled === false) this._sessionSpentMinor -= entry.amountMinor;
    this._pending.delete(id);
    return true;
  }

  /** Current session spend in minor units (includes pending outcome_unknown amounts). */
  get sessionSpentMinor() {
    return this._sessionSpentMinor;
  }

  /** @returns {boolean} true if any payment is awaiting reconciliation. */
  hasPending() {
    return this._pending.size > 0;
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

function assertValidAmount(amount, where) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`${where}: amount must be a non-negative integer in minor units (got ${typeof amount === 'bigint' ? amount + 'n' : String(amount)})`);
  }
}

module.exports = { SpendGuard };

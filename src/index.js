'use strict';

const { SpendGuard } = require('./spendGuard');
const { AuditLog } = require('./auditLog');

/**
 * guardedPay — the main entry point.
 *
 * Wraps a real MPP payment call with a SpendGuard check + audit logging.
 * `mppClient` is intentionally abstract here (dependency injection) so this
 * module has zero network dependency and can be unit-tested without mppx
 * installed. In your real agent, pass an object with a `.pay(challenge)`
 * method backed by the actual mppx SDK — see README.md "Wiring to the real
 * SDK" for the few lines that requires.
 *
 * @param {object} mppClient        Must expose an async pay(challenge) -> Receipt.
 * @param {object} challenge        The MPP Challenge (402 response) describing the charge.
 * @param {SpendGuard} guard        A SpendGuard instance (create once per session).
 * @param {AuditLog} [auditLog]     Optional; defaults to ./audit.log in cwd.
 * @returns {Promise<{paid: boolean, receipt?: object, decision: object}>}
 */
async function guardedPay(mppClient, challenge, guard, auditLog = new AuditLog()) {
  const decision = guard.evaluate(challenge);
  auditLog.record({ challenge, decision });

  if (!decision.allowed) {
    return { paid: false, decision };
  }

  const receipt = await mppClient.pay(challenge);
  guard.recordSpend(challenge.amountMinor);

  return { paid: true, receipt, decision };
}

module.exports = { guardedPay, SpendGuard, AuditLog };

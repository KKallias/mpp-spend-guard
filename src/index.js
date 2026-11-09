'use strict';

const crypto = require('node:crypto');
const { SpendGuard } = require('./spendGuard');
const { AuditLog } = require('./auditLog');

/**
 * guardedPay — the main entry point.
 *
 * Wraps a real MPP payment call with a SpendGuard check + audit logging.
 * `mppClient` is intentionally abstract here (dependency injection) so this
 * module has zero network dependency and can be unit-tested without mppx
 * installed. In your real agent, pass an object with a `.pay(challenge, opts)`
 * method backed by the actual mppx SDK — see src/mppClient.js.
 *
 * Failure handling (never throws for payment failures):
 *  - TIMEOUT_BEFORE_SIGNING → nothing paid; no spend recorded.
 *  - OUTCOME_UNKNOWN        → amount counted as spent and held as pending; the
 *    guard blocks further payments to the same resource until
 *    guard.reconcile(paymentId, { settled }) is called.
 *  - anything else          → no spend recorded.
 *
 * @param {object} mppClient        Must expose an async pay(challenge, opts) -> Receipt.
 * @param {object} challenge        The MPP Challenge (402 response) describing the charge.
 * @param {SpendGuard} guard        A SpendGuard instance (create once per session).
 * @param {AuditLog} [auditLog]     Optional; defaults to ./audit.log in cwd.
 * @param {object} [payOpts]        Passed through to mppClient.pay (e.g. { timeoutMs }).
 * @returns {Promise<{paid: boolean, paymentId: string, receipt?: object, decision: object, error?: Error}>}
 */
async function guardedPay(mppClient, challenge, guard, auditLog = new AuditLog(), payOpts) {
  const paymentId = crypto.randomUUID();
  const decision = guard.evaluate(challenge);
  auditLog.record({ challenge, decision, paymentId });

  if (!decision.allowed) {
    return { paid: false, paymentId, decision };
  }

  let receipt;
  try {
    receipt = await mppClient.pay(challenge, payOpts);
  } catch (error) {
    const code = error && error.code;
    let reason;
    let note;
    if (code === 'TIMEOUT_BEFORE_SIGNING') {
      reason = 'timeout_before_signing';
    } else if (code === 'OUTCOME_UNKNOWN') {
      reason = 'outcome_unknown';
      guard.markOutcomeUnknown(paymentId, challenge.amountMinor, challenge.resource);
      note = `needs human reconciliation against on-chain balance — then call guard.reconcile('${paymentId}', { settled })`;
    } else {
      reason = 'payment_failed';
    }
    auditLog.record({
      challenge,
      decision: { allowed: false, reason, sessionSpentMinor: guard.sessionSpentMinor },
      paymentId,
      note: note || (error && error.message),
    });
    return { paid: false, paymentId, decision, error };
  }

  guard.recordSpend(challenge.amountMinor);
  return { paid: true, paymentId, receipt, decision };
}

module.exports = { guardedPay, SpendGuard, AuditLog };

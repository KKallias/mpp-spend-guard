'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpendGuard } = require('../src/spendGuard');
const { AuditLog } = require('../src/auditLog');
const { guardedPay } = require('../src/index');

function mockChallenge(overrides = {}) {
  return {
    resource: 'mpp://example/search',
    amountMinor: 10, // $0.10 in cents, or 10 minor units of whatever currency
    recipient: 'svc_search',
    ...overrides,
  };
}

test('allows a charge within all limits', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 1000 });
  const result = guard.evaluate(mockChallenge());
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'ok');
});

test('blocks a charge above the per-request cap', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 5, sessionCapMinor: 1000 });
  const result = guard.evaluate(mockChallenge({ amountMinor: 10 }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'exceeds_per_request_cap');
});

test('blocks once cumulative session spend would exceed the session cap', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 25 });
  const first = guard.evaluate(mockChallenge({ amountMinor: 20 }));
  assert.equal(first.allowed, true);
  guard.recordSpend(20);

  const second = guard.evaluate(mockChallenge({ amountMinor: 10 }));
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'exceeds_session_cap');
});

test('blocks a recipient not on the allowlist', () => {
  const guard = new SpendGuard({
    perRequestCapMinor: 100,
    sessionCapMinor: 1000,
    allowedRecipients: ['svc_search'],
  });
  const result = guard.evaluate(mockChallenge({ recipient: 'svc_unknown' }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'recipient_not_allowlisted');
});

test('enforces a rate limit within the configured window', () => {
  const guard = new SpendGuard({
    perRequestCapMinor: 100,
    sessionCapMinor: 1000,
    maxRequestsPerWindow: 2,
    windowMs: 60_000,
  });

  assert.equal(guard.evaluate(mockChallenge()).allowed, true);
  guard.recordSpend(10);
  assert.equal(guard.evaluate(mockChallenge()).allowed, true);
  guard.recordSpend(10);
  // Third request within the same window should be blocked.
  const third = guard.evaluate(mockChallenge());
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'rate_limit_exceeded');
});

test('guardedPay records every decision to the audit log, including blocks', async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-guard-')), 'audit.log');
  const auditLog = new AuditLog(tmpFile);
  const guard = new SpendGuard({ perRequestCapMinor: 5, sessionCapMinor: 1000 });

  let paidCalls = 0;
  const fakeMppClient = {
    async pay(challenge) {
      paidCalls += 1;
      return { receiptId: 'rcpt_1', resource: challenge.resource };
    },
  };

  // This one should be blocked (amount 10 > per-request cap 5) — pay() must NOT be called.
  const blocked = await guardedPay(fakeMppClient, mockChallenge({ amountMinor: 10 }), guard, auditLog);
  assert.equal(blocked.paid, false);
  assert.equal(paidCalls, 0);

  // This one should be allowed.
  const allowed = await guardedPay(fakeMppClient, mockChallenge({ amountMinor: 3 }), guard, auditLog);
  assert.equal(allowed.paid, true);
  assert.equal(paidCalls, 1);

  const entries = auditLog.readAll();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].allowed, false);
  assert.equal(entries[1].allowed, true);
});

// --- Day 4: failure states ---------------------------------------------------

function tmpAuditLog() {
  return new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-guard-')), 'audit.log'));
}

test('rejects every malformed amount with invalid_amount', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 1000 });
  const bad = [NaN, Infinity, -Infinity, 1.5, '100', undefined, null, -1, 100000n];
  for (const amountMinor of bad) {
    const result = guard.evaluate(mockChallenge({ amountMinor }));
    assert.equal(result.allowed, false, `expected ${String(amountMinor)} to be denied`);
    assert.equal(result.reason, 'invalid_amount', `wrong reason for ${String(amountMinor)}`);
  }
});

test('guardedPay logs a bigint amount without crashing and never calls pay()', async () => {
  const guard = new SpendGuard({ perRequestCapMinor: 1_000_000, sessionCapMinor: 1_000_000 });
  const auditLog = tmpAuditLog();
  let calls = 0;
  const client = { async pay() { calls += 1; } };
  const result = await guardedPay(client, mockChallenge({ amountMinor: 100000n }), guard, auditLog);
  assert.equal(result.paid, false);
  assert.equal(result.decision.reason, 'invalid_amount');
  assert.equal(calls, 0);
  assert.equal(auditLog.readAll()[0].amountMinor, '100000n');
});

test('recordSpend(NaN) throws without poisoning the session total', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 25 });
  for (const bad of [NaN, Infinity, 1.5, -1, '10', 10n, undefined]) {
    assert.throws(() => guard.recordSpend(bad), /non-negative integer/);
  }
  assert.equal(guard.sessionSpentMinor, 0);

  guard.recordSpend(20);
  const next = guard.evaluate(mockChallenge({ amountMinor: 10 }));
  assert.equal(next.allowed, false);
  assert.equal(next.reason, 'exceeds_session_cap');
});

test('markOutcomeUnknown counts the amount and blocks a retry with pending_reconciliation', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 1000 });
  guard.markOutcomeUnknown('pay_1', 40, 'mpp://example/search');
  assert.equal(guard.sessionSpentMinor, 40);
  assert.equal(guard.hasPending(), true);

  const retry = guard.evaluate(mockChallenge());
  assert.equal(retry.allowed, false);
  assert.equal(retry.reason, 'pending_reconciliation');

  // A different resource is not blocked.
  assert.equal(guard.evaluate(mockChallenge({ resource: 'mpp://example/other' })).allowed, true);
});

test('reconcile({settled:false}) releases the amount; settled:true keeps it', () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 1000 });
  guard.markOutcomeUnknown('pay_1', 40, 'mpp://example/search');
  guard.markOutcomeUnknown('pay_2', 30, 'mpp://example/other');

  assert.equal(guard.reconcile('pay_1', { settled: false }), true);
  assert.equal(guard.sessionSpentMinor, 30);
  assert.equal(guard.evaluate(mockChallenge()).allowed, true);

  assert.equal(guard.reconcile('pay_2', { settled: true }), true);
  assert.equal(guard.sessionSpentMinor, 30);
  assert.equal(guard.hasPending(), false);
  assert.equal(guard.reconcile('nope', { settled: false }), false);
});

test('guardedPay: OUTCOME_UNKNOWN is counted, held pending, and blocks a second pay', async () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 1000 });
  const auditLog = tmpAuditLog();
  let calls = 0;
  const fakeClient = {
    async pay() {
      calls += 1;
      // Simulate: credential signed and sent, then the connection hung/dropped.
      const err = new Error('credential may have been sent');
      err.code = 'OUTCOME_UNKNOWN';
      throw err;
    },
  };

  const first = await guardedPay(fakeClient, mockChallenge({ amountMinor: 40 }), guard, auditLog);
  assert.equal(first.paid, false);
  assert.equal(first.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(guard.sessionSpentMinor, 40);

  const second = await guardedPay(fakeClient, mockChallenge({ amountMinor: 40 }), guard, auditLog);
  assert.equal(second.paid, false);
  assert.equal(second.decision.reason, 'pending_reconciliation');
  assert.equal(calls, 1);

  const entries = auditLog.readAll();
  assert.deepEqual(entries.map((e) => e.reason), ['ok', 'outcome_unknown', 'pending_reconciliation']);
  assert.equal(entries[1].paymentId, first.paymentId);
  assert.match(entries[1].note, /needs human reconciliation against on-chain balance/);

  guard.reconcile(first.paymentId, { settled: false });
  assert.equal(guard.sessionSpentMinor, 0);
  assert.equal(guard.hasPending(), false);
});

test('guardedPay: other payment errors record no spend and return payment_failed', async () => {
  const guard = new SpendGuard({ perRequestCapMinor: 100, sessionCapMinor: 1000 });
  const auditLog = tmpAuditLog();
  const fakeClient = { async pay() { throw new Error('boom'); } };
  const result = await guardedPay(fakeClient, mockChallenge(), guard, auditLog);
  assert.equal(result.paid, false);
  assert.equal(guard.sessionSpentMinor, 0);
  assert.equal(guard.hasPending(), false);
  assert.deepEqual(auditLog.readAll().map((e) => e.reason), ['ok', 'payment_failed']);
});

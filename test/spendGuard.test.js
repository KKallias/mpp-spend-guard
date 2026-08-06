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
